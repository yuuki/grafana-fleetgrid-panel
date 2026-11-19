import { DataFrame, Field, FieldType } from '@grafana/data';
import { HierarchyNode, LevelDef, SpatialAggregation } from '../types';
import { extractKey, pathKey } from './hierarchy';
import { isTableFrame } from './normalize';

/**
 * Memory cap per refId: 4M Float64 slots (~32 MB). When T * C exceeds this cap,
 * timestamps are uniformly downsampled (always keeping first and last) so large
 * fleets over long ranges cannot exhaust browser memory.
 */
export const MAX_TIMELINE_SLOTS = 4_000_000;

export interface TimelineIndex {
  /** Sorted unique epoch-ms timestamps across all time-series frames (length T >= 2). */
  timestamps: Float64Array;
  /** Number of leaf cells in the hierarchy (C). */
  cellCount: number;
  /** Map from pathKey(cell.path) to its stable cell index [0..C-1]. */
  cellIndexByPath: Map<string, number>;
  /**
   * Dense Float64Array of length T * C per refId, indexed as [timeIndex * cellCount + cellIndex].
   * Missing or non-finite samples are stored as NaN.
   */
  valuesByRef: Map<string, Float64Array>;
  /** Global finite min/max across the entire timeline per refId (for flicker-free playback scales). */
  rangeByRef: Map<string, { min: number; max: number }>;
  /** True when timestamps were uniformly downsampled to stay within memory bounds. */
  downsampled: boolean;
  /** Original distinct timestamp count before downsampling. */
  rawTimestampCount: number;
}

interface TimeSeriesFrame {
  refId: string;
  timeField: Field;
  numberFields: Field[];
}

export function collectLeafCellIndices(root: HierarchyNode, levelsLength: number): Map<string, number> {
  const indexByPath = new Map<string, number>();
  const visit = (node: HierarchyNode) => {
    if (node.children.length === 0 && node.path.length === levelsLength && node.cell) {
      indexByPath.set(pathKey(node.path), indexByPath.size);
      return;
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return indexByPath;
}

function extractTimeSeriesFrames(frames: DataFrame[]): TimeSeriesFrame[] {
  const out: TimeSeriesFrame[] = [];
  for (const frame of frames) {
    if (frame.length < 2 || isTableFrame(frame)) {
      continue;
    }
    const timeField = frame.fields.find((f) => f.type === FieldType.time);
    if (!timeField) {
      continue;
    }
    const numberFields = frame.fields.filter((f) => f.type === FieldType.number);
    if (numberFields.length === 0) {
      continue;
    }
    out.push({ refId: frame.refId ?? 'A', timeField, numberFields });
  }
  return out;
}

function fieldCellIndex(
  field: Field,
  levels: LevelDef[],
  cellIndexByPath: Map<string, number>
): number {
  const labels = field.labels;
  if (!labels) {
    return -1;
  }
  const path: string[] = [];
  for (const level of levels) {
    const raw = labels[level.label];
    if (raw === undefined) {
      return -1;
    }
    const key = extractKey(raw, level);
    if (key === null) {
      return -1;
    }
    path.push(key);
  }
  return cellIndexByPath.get(pathKey(path)) ?? -1;
}

function collectDistinctTimestamps(tsFrames: TimeSeriesFrame[]): number[] {
  const seen = new Set<number>();
  for (const tf of tsFrames) {
    const vals = tf.timeField.values;
    for (let i = 0; i < vals.length; i++) {
      const ts = Number(vals[i]);
      if (Number.isFinite(ts)) {
        seen.add(ts);
      }
    }
  }
  const sorted = [...seen];
  sorted.sort((a, b) => a - b);
  return sorted;
}

function downsampleTimestamps(sorted: number[], maxSteps: number): { timestamps: Float64Array; downsampled: boolean } {
  if (sorted.length <= maxSteps) {
    return { timestamps: Float64Array.from(sorted), downsampled: false };
  }
  const count = Math.max(2, maxSteps);
  const sampled = new Float64Array(count);
  const last = sorted.length - 1;
  for (let i = 0; i < count; i++) {
    const idx = i === count - 1 ? last : Math.round((i * last) / (count - 1));
    sampled[i] = sorted[idx];
  }
  return { timestamps: sampled, downsampled: true };
}

function mapFrameTimeIndices(timeField: Field, timestamps: Float64Array, tsToIndex: Map<number, number>): Int32Array {
  const vals = timeField.values;
  const n = vals.length;
  const mapped = new Int32Array(n);
  // Fast path: exact alignment with the unified timestamps array (common Prometheus/VictoriaMetrics case).
  if (n === timestamps.length && Number(vals[0]) === timestamps[0] && Number(vals[n - 1]) === timestamps[n - 1]) {
    let aligned = true;
    for (let i = 0; i < n; i++) {
      if (Number(vals[i]) !== timestamps[i]) {
        aligned = false;
        break;
      }
      mapped[i] = i;
    }
    if (aligned) {
      return mapped;
    }
  }
  for (let i = 0; i < n; i++) {
    const ts = Number(vals[i]);
    mapped[i] = Number.isFinite(ts) ? (tsToIndex.get(ts) ?? -1) : -1;
  }
  return mapped;
}

function accumulateSample(
  arr: Float64Array,
  counts: Uint32Array,
  slot: number,
  val: number,
  agg: SpatialAggregation
): void {
  const count = counts[slot];
  if (count === 0) {
    arr[slot] = val;
    counts[slot] = 1;
    return;
  }
  counts[slot] = count + 1;
  if (agg === 'max') {
    if (val > arr[slot]) {
      arr[slot] = val;
    }
  } else if (agg === 'min') {
    if (val < arr[slot]) {
      arr[slot] = val;
    }
  } else {
    arr[slot] += val;
  }
}

function accumulateSeriesField(
  field: Field,
  cellIdx: number,
  timeIndices: Int32Array,
  cellCount: number,
  arr: Float64Array,
  counts: Uint32Array,
  agg: SpatialAggregation
): void {
  const values = field.values;
  const len = Math.min(values.length, timeIndices.length);
  for (let i = 0; i < len; i++) {
    const tIdx = timeIndices[i];
    if (tIdx < 0) {
      continue;
    }
    const raw = values[i];
    if (raw == null) {
      continue;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      continue;
    }
    accumulateSample(arr, counts, tIdx * cellCount + cellIdx, num, agg);
  }
}

function finalizeArrayAndRange(
  arr: Float64Array,
  counts: Uint32Array,
  agg: SpatialAggregation
): { min: number; max: number } | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < arr.length; i++) {
    const c = counts[i];
    if (c === 0) {
      continue;
    }
    if (agg === 'mean' && c > 1) {
      arr[i] /= c;
    }
    const v = arr[i];
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
  }
  return Number.isFinite(min) ? { min, max } : undefined;
}

/**
 * Builds a pre-indexed typed-array timeline over all time-series frames in the query result.
 * Returns undefined when fewer than 2 distinct timestamps exist (e.g. instant or table queries).
 */
export function buildTimelineIndex(
  frames: DataFrame[],
  root: HierarchyNode,
  levels: LevelDef[],
  agg: SpatialAggregation,
  refIds: string[],
  maxSlots: number = MAX_TIMELINE_SLOTS
): TimelineIndex | undefined {
  if (levels.length === 0) {
    return undefined;
  }
  const cellIndexByPath = collectLeafCellIndices(root, levels.length);
  const cellCount = cellIndexByPath.size;
  if (cellCount === 0) {
    return undefined;
  }
  const tsFrames = extractTimeSeriesFrames(frames);
  if (tsFrames.length === 0) {
    return undefined;
  }
  const sorted = collectDistinctTimestamps(tsFrames);
  if (sorted.length < 2) {
    return undefined;
  }
  const maxSteps = Math.max(2, Math.floor(maxSlots / cellCount));
  const { timestamps, downsampled } = downsampleTimestamps(sorted, maxSteps);
  const tsToIndex = new Map<number, number>();
  for (let i = 0; i < timestamps.length; i++) {
    tsToIndex.set(timestamps[i], i);
  }

  const totalSlots = timestamps.length * cellCount;
  const valuesByRef = new Map<string, Float64Array>();
  const countsByRef = new Map<string, Uint32Array>();
  const ensureRef = (refId: string) => {
    let arr = valuesByRef.get(refId);
    let counts = countsByRef.get(refId);
    if (!arr || !counts) {
      arr = new Float64Array(totalSlots);
      arr.fill(Number.NaN);
      counts = new Uint32Array(totalSlots);
      valuesByRef.set(refId, arr);
      countsByRef.set(refId, counts);
    }
    return { arr, counts };
  };

  for (const refId of refIds) {
    ensureRef(refId);
  }

  for (const tf of tsFrames) {
    const timeIndices = mapFrameTimeIndices(tf.timeField, timestamps, tsToIndex);
    const { arr, counts } = ensureRef(tf.refId);
    for (const field of tf.numberFields) {
      const cellIdx = fieldCellIndex(field, levels, cellIndexByPath);
      if (cellIdx < 0) {
        continue;
      }
      accumulateSeriesField(field, cellIdx, timeIndices, cellCount, arr, counts, agg);
    }
  }

  const rangeByRef = new Map<string, { min: number; max: number }>();
  for (const [refId, arr] of valuesByRef) {
    const counts = countsByRef.get(refId)!;
    const range = finalizeArrayAndRange(arr, counts, agg);
    if (range) {
      rangeByRef.set(refId, range);
    }
  }

  return {
    timestamps,
    cellCount,
    cellIndexByPath,
    valuesByRef,
    rangeByRef,
    downsampled,
    rawTimestampCount: sorted.length,
  };
}

/**
 * Finds the timestamp index for lookback offset `lookbackSec` before `timestamps[timeIndex]`.
 * When `lookbackSec <= 0` (or non-finite), returns the immediate previous step (`timeIndex - 1`).
 * Returns -1 when no timestamp exists at or before the lookback target.
 */
export function findLookbackIndex(timestamps: Float64Array, timeIndex: number, lookbackSec: number): number {
  if (timeIndex <= 0 || timeIndex >= timestamps.length) {
    return -1;
  }
  if (!Number.isFinite(lookbackSec) || lookbackSec <= 0) {
    return timeIndex - 1;
  }
  const target = timestamps[timeIndex] - lookbackSec * 1000;
  if (timestamps[0] > target) {
    return -1;
  }
  let lo = 0;
  let hi = timeIndex - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timestamps[mid] <= target) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Reads a single cell value at `timeIndex`, returning null when missing or out of bounds. */
export function timelineValueAt(
  timeline: TimelineIndex,
  refId: string,
  timeIndex: number,
  cellIndex: number
): number | null {
  if (timeIndex < 0 || timeIndex >= timeline.timestamps.length || cellIndex < 0 || cellIndex >= timeline.cellCount) {
    return null;
  }
  const arr = timeline.valuesByRef.get(refId);
  if (!arr) {
    return null;
  }
  const v = arr[timeIndex * timeline.cellCount + cellIndex];
  return Number.isFinite(v) ? v : null;
}
