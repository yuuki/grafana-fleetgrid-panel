import { DataFrame, Field, FieldType } from '@grafana/data';
import { HierarchyNode, LevelDef, SpatialAggregation } from '../types';
import { extractKey, pathKey } from './hierarchy';
import { isTableFrame } from './normalize';

/**
 * Total typed-array slot cap across all refIds (~32 MB of Float64 values across metrics).
 * When refCount * T * C exceeds this cap, timestamps are uniformly downsampled (always
 * keeping first and last) so large fleets over long ranges cannot exhaust browser memory.
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

interface MappedFrameTimes {
  indices: Int32Array;
  hasDuplicates: boolean;
}

function toFiniteTimestamp(raw: unknown): number | null {
  if (raw == null || raw === '') {
    return null;
  }
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : null;
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
    // Allow 1-point time-series frames (e.g. a newly booted node) alongside multi-point frames;
    // the global >= 2 distinct timestamps requirement is enforced after merging all frames.
    if (frame.length < 1 || isTableFrame(frame)) {
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

function fieldCellIndex(field: Field, levels: LevelDef[], cellIndexByPath: Map<string, number>): number {
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
      const ts = toFiniteTimestamp(vals[i]);
      if (ts !== null) {
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

function isExactAligned(vals: unknown[], timestamps: Float64Array): boolean {
  const n = vals.length;
  if (n !== timestamps.length) {
    return false;
  }
  for (let i = 0; i < n; i++) {
    if (toFiniteTimestamp(vals[i]) !== timestamps[i]) {
      return false;
    }
  }
  return true;
}

function mapFrameTimeIndices(
  timeField: Field,
  timestamps: Float64Array,
  tsToIndex: Map<number, number>
): MappedFrameTimes {
  const vals = timeField.values;
  const n = vals.length;
  const indices = new Int32Array(n);
  if (isExactAligned(vals, timestamps)) {
    for (let i = 0; i < n; i++) {
      indices[i] = i;
    }
    return { indices, hasDuplicates: false };
  }
  const seen = new Set<number>();
  let hasDuplicates = false;
  for (let i = 0; i < n; i++) {
    const ts = toFiniteTimestamp(vals[i]);
    const idx = ts !== null ? (tsToIndex.get(ts) ?? -1) : -1;
    indices[i] = idx;
    if (idx >= 0) {
      if (seen.has(idx)) {
        hasDuplicates = true;
      } else {
        seen.add(idx);
      }
    }
  }
  return { indices, hasDuplicates };
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

function toFiniteSample(raw: unknown): number | null {
  if (raw == null || raw === '') {
    return null;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function accumulateSeriesField(
  field: Field,
  cellIdx: number,
  mapped: MappedFrameTimes,
  cellCount: number,
  arr: Float64Array,
  counts: Uint32Array,
  agg: SpatialAggregation
): void {
  const values = field.values;
  const len = Math.min(values.length, mapped.indices.length);
  if (!mapped.hasDuplicates) {
    for (let i = 0; i < len; i++) {
      const tIdx = mapped.indices[i];
      if (tIdx < 0) {
        continue;
      }
      const num = toFiniteSample(values[i]);
      if (num !== null) {
        accumulateSample(arr, counts, tIdx * cellCount + cellIdx, num, agg);
      }
    }
    return;
  }
  // When a single series repeats a timestamp, keep its last finite sample at that timestamp
  // so sum/mean spatial aggregation does not double-count one series against its siblings.
  const deduped = new Map<number, number>();
  for (let i = 0; i < len; i++) {
    const tIdx = mapped.indices[i];
    if (tIdx < 0) {
      continue;
    }
    const num = toFiniteSample(values[i]);
    if (num !== null) {
      deduped.set(tIdx, num);
    }
  }
  for (const [tIdx, num] of deduped) {
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
    if (!Number.isFinite(v)) {
      // Coerce overflowed sum/mean (+/-Infinity) back to NaN to uphold the missing-value contract.
      arr[i] = Number.NaN;
      continue;
    }
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : undefined;
}

function groupFramesByRef(tsFrames: TimeSeriesFrame[], refIds: string[]): Map<string, TimeSeriesFrame[]> {
  const byRef = new Map<string, TimeSeriesFrame[]>();
  for (const refId of refIds) {
    byRef.set(refId, []);
  }
  for (const tf of tsFrames) {
    const list = byRef.get(tf.refId);
    if (list) {
      list.push(tf);
    } else {
      byRef.set(tf.refId, [tf]);
    }
  }
  return byRef;
}

function populateRefValues(
  refFrames: TimeSeriesFrame[],
  timestamps: Float64Array,
  tsToIndex: Map<number, number>,
  levels: LevelDef[],
  cellIndexByPath: Map<string, number>,
  agg: SpatialAggregation,
  counts: Uint32Array
): { arr: Float64Array; range: { min: number; max: number } | undefined } {
  const cellCount = cellIndexByPath.size;
  const arr = new Float64Array(timestamps.length * cellCount);
  arr.fill(Number.NaN);
  counts.fill(0);
  for (const tf of refFrames) {
    const mapped = mapFrameTimeIndices(tf.timeField, timestamps, tsToIndex);
    for (const field of tf.numberFields) {
      const cellIdx = fieldCellIndex(field, levels, cellIndexByPath);
      if (cellIdx >= 0) {
        accumulateSeriesField(field, cellIdx, mapped, cellCount, arr, counts, agg);
      }
    }
  }
  return { arr, range: finalizeArrayAndRange(arr, counts, agg) };
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
  const framesByRef = groupFramesByRef(tsFrames, refIds);
  const refCount = Math.max(1, framesByRef.size);
  const maxSteps = Math.max(2, Math.floor(maxSlots / (cellCount * refCount)));
  const { timestamps, downsampled } = downsampleTimestamps(sorted, maxSteps);
  const tsToIndex = new Map<number, number>();
  for (let i = 0; i < timestamps.length; i++) {
    tsToIndex.set(timestamps[i], i);
  }

  // Process one refId at a time and reuse a single Uint32Array to minimize peak transient memory.
  const counts = new Uint32Array(timestamps.length * cellCount);
  const valuesByRef = new Map<string, Float64Array>();
  const rangeByRef = new Map<string, { min: number; max: number }>();

  for (const [refId, refFrames] of framesByRef) {
    const { arr, range } = populateRefValues(refFrames, timestamps, tsToIndex, levels, cellIndexByPath, agg, counts);
    valuesByRef.set(refId, arr);
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
