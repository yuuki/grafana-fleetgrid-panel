import { DisplayProcessor, DisplayValue, GrafanaTheme2, getDisplayProcessor } from '@grafana/data';
import { ColorMode, HierarchyNode, ZScoreMethod } from '../types';
import { DisplayRangeInfo } from './cellRange';
import { MetricInfo, normalizeEffectiveRange } from './display';
import { pathKey } from './hierarchy';
import { TimelineIndex, findLookbackIndex } from './timeline';

const DEFAULT_ZSCORE_LIMIT = 3;
/** Consistency factor scaling MAD to match normal-distribution standard deviation. */
const MAD_TO_STD = 1.4826;
/** Consistency factor scaling mean absolute deviation (from median) when MAD is 0. */
const MEAN_AD_TO_STD = 1.253314;

type RGB = [number, number, number];

// Perceptually balanced blue -> neutral -> red diverging stops (inspired by ColorBrewer RdBu).
// Neutral midpoint adapts to dark/light themes so zero-change cells stay visually quiet.
const NEG_STRONG: RGB = [33, 102, 172]; // #2166AC
const NEG_MID: RGB = [103, 169, 207]; // #67A9CF
const NEUTRAL_DARK: RGB = [58, 63, 75]; // #3A3F4B
const NEUTRAL_LIGHT: RGB = [232, 236, 239]; // #E8ECEF
const POS_MID: RGB = [239, 138, 98]; // #EF8A62
const POS_STRONG: RGB = [178, 24, 43]; // #B2182B

function lerpRgb(a: RGB, b: RGB, t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

/**
 * Maps a normalized ratio in [-1, 1] onto the diverging blue-neutral-red palette.
 * 0 maps to the theme-appropriate neutral tone; -1 is cool blue; +1 is warm red.
 */
export function divergingColor(ratio: number, isDark: boolean): string {
  const clamped = Math.max(-1, Math.min(1, ratio));
  const neutral = isDark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
  if (clamped < -0.5) {
    return lerpRgb(NEG_STRONG, NEG_MID, (clamped + 1) * 2);
  }
  if (clamped < 0) {
    return lerpRgb(NEG_MID, neutral, (clamped + 0.5) * 2);
  }
  if (clamped <= 0.5) {
    return lerpRgb(neutral, POS_MID, clamped * 2);
  }
  return lerpRgb(POS_MID, POS_STRONG, (clamped - 0.5) * 2);
}

/**
 * Maps a numeric value within [min, max] onto [-1, 1].
 * When the range straddles zero (min < 0 < max), zero is pinned to 0 so neutral
 * always represents zero change / zero deviation even for asymmetric endpoints.
 */
export function valueToDivergingRatio(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 0;
  }
  if (min < 0 && max > 0) {
    return value >= 0 ? Math.min(1, value / max) : Math.max(-1, value / Math.abs(min));
  }
  const normalized = ((value - min) / (max - min)) * 2 - 1;
  return Math.max(-1, Math.min(1, normalized));
}

export function formatLookbackLabel(lookbackSec: number): string {
  if (!Number.isFinite(lookbackSec) || lookbackSec <= 0) {
    return '1 step';
  }
  const rounded = Math.round(lookbackSec);
  if (rounded >= 3600 && rounded % 3600 === 0) {
    return `${rounded / 3600}h`;
  }
  if (rounded >= 60 && rounded % 60 === 0) {
    return `${rounded / 60}m`;
  }
  return `${rounded}s`;
}

/**
 * Wraps a metric's Grafana display processor so Temporal Delta values keep the metric's
 * configured unit and decimals, show an explicit '+' sign for positive deltas, and use
 * the diverging palette.
 */
export function buildDeltaProcessor(
  baseProcessor: DisplayProcessor,
  min: number,
  max: number,
  theme: GrafanaTheme2
): DisplayProcessor {
  const isDark = theme.isDark;
  return (value: unknown): DisplayValue => {
    const num = Number(value);
    const base = baseProcessor(value);
    if (!Number.isFinite(num)) {
      return base;
    }
    const text = num > 0 && !base.text.startsWith('+') && !base.text.startsWith('-') ? `+${base.text}` : base.text;
    return {
      ...base,
      text,
      color: divergingColor(valueToDivergingRatio(num, min, max), isDark),
    };
  };
}

/**
 * Builds a diverging display processor for spatial Z-scores formatted as signed sigma values.
 */
export function buildZScoreProcessor(
  min: number,
  max: number,
  decimals: number | null | undefined,
  theme: GrafanaTheme2
): DisplayProcessor {
  const isDark = theme.isDark;
  const digits = decimals != null && Number.isFinite(decimals) && decimals >= 0 ? Math.min(6, Math.floor(decimals)) : 1;
  return (value: unknown): DisplayValue => {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return { numeric: Number.NaN, text: '', color: undefined };
    }
    const fixed = num.toFixed(digits);
    const text = num > 0 && !fixed.startsWith('+') ? `+${fixed}` : fixed;
    return {
      numeric: num,
      text,
      suffix: 'σ',
      color: divergingColor(valueToDivergingRatio(num, min, max), isDark),
    };
  };
}

export interface SiblingGroup {
  path: string[];
  cellIndices: number[];
}

export interface ZScoreCellStat {
  center: number;
  spread: number;
  groupSize: number;
  groupPath: string[];
}

/**
 * Resolves the tree depth (0 = root / entire fleet, 1 = level 0, ...) at which sibling cells
 * are grouped for Z-score calculation.
 * - configuredDepth === -2: entire fleet (depth 0)
 * - configuredDepth === undefined || -1: immediate parent of leaf (depth levelsLength - 1)
 * - configuredDepth >= 0: 0-based level index (mapped to depth configuredDepth + 1, clamped below leaf depth)
 */
export function resolveZScoreGroupDepth(levelsLength: number, configuredDepth: number | undefined): number {
  const maxGroupDepth = Math.max(0, levelsLength - 1);
  if (configuredDepth === -2) {
    return 0;
  }
  if (configuredDepth === undefined || !Number.isFinite(configuredDepth) || configuredDepth < 0) {
    return maxGroupDepth;
  }
  return Math.min(Math.floor(configuredDepth) + 1, maxGroupDepth);
}

function collectSubtreeLeafIndices(
  node: HierarchyNode,
  levelsLength: number,
  cellIndexByPath: Map<string, number>,
  out: number[]
): void {
  if (node.children.length === 0 && node.path.length === levelsLength) {
    const idx = cellIndexByPath.get(pathKey(node.path));
    if (idx !== undefined) {
      out.push(idx);
    }
    return;
  }
  for (const child of node.children) {
    collectSubtreeLeafIndices(child, levelsLength, cellIndexByPath, out);
  }
}

export function buildSiblingGroups(
  root: HierarchyNode,
  levelsLength: number,
  cellIndexByPath: Map<string, number>,
  configuredDepth: number | undefined
): SiblingGroup[] {
  const targetDepth = resolveZScoreGroupDepth(levelsLength, configuredDepth);
  const groups: SiblingGroup[] = [];
  const visit = (node: HierarchyNode) => {
    if (node.path.length === targetDepth) {
      const cellIndices: number[] = [];
      collectSubtreeLeafIndices(node, levelsLength, cellIndexByPath, cellIndices);
      if (cellIndices.length > 0) {
        groups.push({ path: node.path, cellIndices });
      }
      return;
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return groups;
}

function sortedMedian(sorted: number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function groupCenterAndSpread(vals: number[], method: ZScoreMethod): { center: number; spread: number } {
  const n = vals.length;
  if (method === 'median') {
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sortedMedian(sorted);
    const absDevs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = sortedMedian(absDevs);
    if (mad > 0) {
      return { center: med, spread: MAD_TO_STD * mad };
    }
    // When >50% of siblings share the exact median, MAD is 0 even if an outlier exists;
    // fall back to scaled mean absolute deviation so outliers remain detectable.
    const meanAd = absDevs.reduce((acc, d) => acc + d, 0) / n;
    return { center: med, spread: meanAd > 0 ? MEAN_AD_TO_STD * meanAd : 0 };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += vals[i];
  }
  const mean = sum / n;
  let sqSum = 0;
  for (let i = 0; i < n; i++) {
    const diff = vals[i] - mean;
    sqSum += diff * diff;
  }
  return { center: mean, spread: Math.sqrt(sqSum / n) };
}

export interface SpatialZScoreResult {
  values: Float64Array;
  statsByCell: Array<ZScoreCellStat | undefined>;
  maxAbs: number;
}

function collectFiniteGroupValues(rawValues: Float64Array, cellIndices: number[]): number[] {
  const finiteVals: number[] = [];
  for (const idx of cellIndices) {
    const v = rawValues[idx];
    if (Number.isFinite(v)) {
      finiteVals.push(v);
    }
  }
  return finiteVals;
}

function scoreSiblingGroup(
  rawValues: Float64Array,
  group: SiblingGroup,
  method: ZScoreMethod,
  outValues: Float64Array,
  statsByCell: Array<ZScoreCellStat | undefined>
): number {
  const finiteVals = collectFiniteGroupValues(rawValues, group.cellIndices);
  if (finiteVals.length < 2) {
    return 0;
  }
  const { center, spread } = groupCenterAndSpread(finiteVals, method);
  const stat: ZScoreCellStat = {
    center,
    spread,
    groupSize: finiteVals.length,
    groupPath: group.path,
  };
  let groupMaxAbs = 0;
  for (const idx of group.cellIndices) {
    const v = rawValues[idx];
    if (!Number.isFinite(v)) {
      continue;
    }
    const z = spread > 0 ? (v - center) / spread : 0;
    outValues[idx] = z;
    statsByCell[idx] = stat;
    const absZ = Math.abs(z);
    if (absZ > groupMaxAbs) {
      groupMaxAbs = absZ;
    }
  }
  return groupMaxAbs;
}

/**
 * Computes per-cell spatial Z-scores within each sibling group.
 * Groups with fewer than 2 finite values produce NaN (unknown is not zero).
 * Groups where all valid values are identical produce 0 (zero deviation).
 */
export function computeSpatialZScores(
  rawValues: Float64Array,
  groups: SiblingGroup[],
  method: ZScoreMethod
): SpatialZScoreResult {
  const cellCount = rawValues.length;
  const values = new Float64Array(cellCount);
  values.fill(Number.NaN);
  const statsByCell: Array<ZScoreCellStat | undefined> = new Array(cellCount);
  let maxAbs = 0;

  for (const group of groups) {
    const groupMaxAbs = scoreSiblingGroup(rawValues, group, method, values, statsByCell);
    if (groupMaxAbs > maxAbs) {
      maxAbs = groupMaxAbs;
    }
  }

  return { values, statsByCell, maxAbs };
}

export interface TemporalDeltaSliceResult {
  values: Float64Array;
  rawValues: Float64Array;
  baselineValues: Float64Array;
  prevIndex: number;
  maxAbs: number;
}

/**
 * Computes v(t) - v(t - Δt) for every cell in a single refId at `timeIndex`.
 */
export function computeTemporalDeltaSlice(
  timeline: TimelineIndex,
  refId: string,
  timeIndex: number,
  lookbackSec: number
): TemporalDeltaSliceResult {
  const C = timeline.cellCount;
  const values = new Float64Array(C);
  values.fill(Number.NaN);
  const rawValues = new Float64Array(C);
  rawValues.fill(Number.NaN);
  const baselineValues = new Float64Array(C);
  baselineValues.fill(Number.NaN);

  const arr = timeline.valuesByRef.get(refId);
  if (!arr || timeIndex < 0 || timeIndex >= timeline.timestamps.length) {
    return { values, rawValues, baselineValues, prevIndex: -1, maxAbs: 0 };
  }

  const currOffset = timeIndex * C;
  for (let c = 0; c < C; c++) {
    rawValues[c] = arr[currOffset + c];
  }

  const prevIndex = findLookbackIndex(timeline.timestamps, timeIndex, lookbackSec);
  if (prevIndex < 0) {
    return { values, rawValues, baselineValues, prevIndex: -1, maxAbs: 0 };
  }

  const prevOffset = prevIndex * C;
  let maxAbs = 0;
  for (let c = 0; c < C; c++) {
    const curr = arr[currOffset + c];
    const prev = arr[prevOffset + c];
    baselineValues[c] = prev;
    if (Number.isFinite(curr) && Number.isFinite(prev)) {
      const d = curr - prev;
      values[c] = d;
      const absD = Math.abs(d);
      if (absD > maxAbs) {
        maxAbs = absD;
      }
    }
  }
  return { values, rawValues, baselineValues, prevIndex, maxAbs };
}

/**
 * Computes the maximum |v(t) - v(t - Δt)| across the entire timeline for one refId,
 * giving playback a temporally stable symmetric diverging scale.
 */
export function computeTemporalDeltaGlobalMaxAbs(
  timeline: TimelineIndex,
  refId: string,
  lookbackSec: number
): number {
  const arr = timeline.valuesByRef.get(refId);
  if (!arr) {
    return 0;
  }
  const T = timeline.timestamps.length;
  const C = timeline.cellCount;
  let maxAbs = 0;
  for (let t = 1; t < T; t++) {
    const prevIdx = findLookbackIndex(timeline.timestamps, t, lookbackSec);
    if (prevIdx < 0) {
      continue;
    }
    const currOffset = t * C;
    const prevOffset = prevIdx * C;
    for (let c = 0; c < C; c++) {
      const curr = arr[currOffset + c];
      const prev = arr[prevOffset + c];
      if (Number.isFinite(curr) && Number.isFinite(prev)) {
        const absD = Math.abs(curr - prev);
        if (absD > maxAbs) {
          maxAbs = absD;
        }
      }
    }
  }
  return maxAbs;
}

export interface MetricFrameSlice {
  /** Active display values indexed by cellIndex (NaN = missing). */
  values: Float64Array;
  /** Raw values at the current frame (set in delta/zscore modes for tooltip context). */
  rawValues?: Float64Array;
  /** Baseline raw values at t - Δt (set in delta mode for tooltip context). */
  baselineValues?: Float64Array;
  /** Per-cell sibling group statistics (set in zscore mode for tooltip context). */
  zScoreStats?: Array<ZScoreCellStat | undefined>;
  /** Effective range and display processor for this mode/frame. */
  rangeInfo: DisplayRangeInfo;
  /** True when rangeInfo replaces per-cell rangeOverrides (true for delta and zscore). */
  overridesCellRanges: boolean;
  /** Short badge describing the transformation (e.g. "Δ 5m" or "Z-score (mean)"). */
  modeLabel?: string;
}

/**
 * Extracts reduced CellModel values into dense Float64Arrays per refId (for Z-score on instant/reduced data).
 */
export function extractReducedValueArrays(
  root: HierarchyNode,
  levelsLength: number,
  cellIndexByPath: Map<string, number>,
  refIds: string[]
): Map<string, Float64Array> {
  const cellCount = cellIndexByPath.size;
  const arrays = new Map<string, Float64Array>();
  for (const refId of refIds) {
    const arr = new Float64Array(cellCount);
    arr.fill(Number.NaN);
    arrays.set(refId, arr);
  }
  const visit = (node: HierarchyNode) => {
    if (node.children.length === 0 && node.path.length === levelsLength && node.cell) {
      const idx = cellIndexByPath.get(pathKey(node.path));
      if (idx !== undefined) {
        for (const [refId, v] of node.cell.values) {
          if (v !== null && Number.isFinite(v)) {
            arrays.get(refId)?.set([v], idx);
          }
        }
      }
      return;
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return arrays;
}

function buildTimelineValueRangeInfo(
  info: MetricInfo,
  timelineRange: { min: number; max: number } | undefined,
  theme: GrafanaTheme2,
  timeZone: string
): DisplayRangeInfo {
  if (!timelineRange || (info.minConfigured && info.maxConfigured)) {
    return info;
  }
  const normalized = normalizeEffectiveRange(
    info.minConfigured ? (info.configuredMin as number) : timelineRange.min,
    info.maxConfigured ? (info.configuredMax as number) : timelineRange.max,
    info.minConfigured,
    info.maxConfigured
  );
  const delta = normalized.max - normalized.min;
  const field = {
    ...info.field,
    config: { ...info.field.config, min: normalized.min, max: normalized.max },
    state: { ...info.field.state, range: { min: normalized.min, max: normalized.max, delta } },
  };
  return {
    effectiveMin: normalized.min,
    effectiveMax: normalized.max,
    minConfigured: info.minConfigured,
    maxConfigured: info.maxConfigured,
    processor: getDisplayProcessor({ field, theme, timeZone }),
  };
}

export function buildTimelineRangeInfos(
  metricInfos: MetricInfo[],
  timeline: TimelineIndex | undefined,
  theme: GrafanaTheme2,
  timeZone: string
): Map<string, DisplayRangeInfo> {
  const out = new Map<string, DisplayRangeInfo>();
  for (const info of metricInfos) {
    out.set(info.refId, buildTimelineValueRangeInfo(info, timeline?.rangeByRef.get(info.refId), theme, timeZone));
  }
  return out;
}

export function buildDeltaRangeInfos(
  metricInfos: MetricInfo[],
  timeline: TimelineIndex | undefined,
  lookbackSec: number,
  theme: GrafanaTheme2
): Map<string, DisplayRangeInfo> {
  const out = new Map<string, DisplayRangeInfo>();
  for (const info of metricInfos) {
    const globalMaxAbs = timeline ? computeTemporalDeltaGlobalMaxAbs(timeline, info.refId, lookbackSec) : 0;
    const safeHalf = globalMaxAbs > 0 && Number.isFinite(globalMaxAbs) ? globalMaxAbs : 1;
    const normalized = normalizeEffectiveRange(
      info.minConfigured ? (info.configuredMin as number) : -safeHalf,
      info.maxConfigured ? (info.configuredMax as number) : safeHalf,
      info.minConfigured,
      info.maxConfigured
    );
    out.set(info.refId, {
      effectiveMin: normalized.min,
      effectiveMax: normalized.max,
      minConfigured: info.minConfigured,
      maxConfigured: info.maxConfigured,
      processor: buildDeltaProcessor(info.processor, normalized.min, normalized.max, theme),
    });
  }
  return out;
}

export interface BuildFrameSlicesArgs {
  colorMode: ColorMode;
  metricInfos: MetricInfo[];
  timeline?: TimelineIndex;
  /** Active timestamp index when scrubbing/playing, or null for reduced/live view. */
  scrubIndex: number | null;
  deltaLookbackSec: number;
  /** Precomputed timeline value ranges (avoids rebuilding Grafana display processors on every scrub frame). */
  timelineRangeInfosByRef?: Map<string, DisplayRangeInfo>;
  /** Precomputed global delta ranges (avoids rescanning the full timeline on every scrub frame). */
  deltaRangeInfosByRef?: Map<string, DisplayRangeInfo>;
  zScoreMethod: ZScoreMethod;
  zScoreLimit: number | undefined;
  siblingGroups?: SiblingGroup[];
  reducedArraysByRef?: Map<string, Float64Array>;
  theme: GrafanaTheme2;
  timeZone: string;
}

function buildValueSlice(
  info: MetricInfo,
  timeline: TimelineIndex,
  timeIndex: number,
  cachedRangeInfo: DisplayRangeInfo | undefined,
  theme: GrafanaTheme2,
  timeZone: string
): MetricFrameSlice {
  const C = timeline.cellCount;
  const full = timeline.valuesByRef.get(info.refId);
  const values = full ? full.subarray(timeIndex * C, (timeIndex + 1) * C) : new Float64Array(C).fill(Number.NaN);
  return {
    values,
    rangeInfo: cachedRangeInfo ?? buildTimelineValueRangeInfo(info, timeline.rangeByRef.get(info.refId), theme, timeZone),
    overridesCellRanges: false,
  };
}

function buildDeltaSlice(
  info: MetricInfo,
  timeline: TimelineIndex | undefined,
  timeIndex: number,
  lookbackSec: number,
  cachedRangeInfo: DisplayRangeInfo | undefined,
  theme: GrafanaTheme2
): MetricFrameSlice {
  const modeLabel = `Δ ${formatLookbackLabel(lookbackSec)}`;
  if (!timeline) {
    const rangeInfo =
      cachedRangeInfo ??
      ({
        effectiveMin: -1,
        effectiveMax: 1,
        minConfigured: false,
        maxConfigured: false,
        processor: buildDeltaProcessor(info.processor, -1, 1, theme),
      } satisfies DisplayRangeInfo);
    return {
      values: new Float64Array(0),
      rangeInfo,
      overridesCellRanges: true,
      modeLabel,
    };
  }
  const slice = computeTemporalDeltaSlice(timeline, info.refId, timeIndex, lookbackSec);
  let rangeInfo = cachedRangeInfo;
  if (!rangeInfo) {
    const safeHalf = slice.maxAbs > 0 && Number.isFinite(slice.maxAbs) ? slice.maxAbs : 1;
    const normalized = normalizeEffectiveRange(
      info.minConfigured ? (info.configuredMin as number) : -safeHalf,
      info.maxConfigured ? (info.configuredMax as number) : safeHalf,
      info.minConfigured,
      info.maxConfigured
    );
    rangeInfo = {
      effectiveMin: normalized.min,
      effectiveMax: normalized.max,
      minConfigured: info.minConfigured,
      maxConfigured: info.maxConfigured,
      processor: buildDeltaProcessor(info.processor, normalized.min, normalized.max, theme),
    };
  }
  return {
    values: slice.values,
    rawValues: slice.rawValues,
    baselineValues: slice.baselineValues,
    rangeInfo,
    overridesCellRanges: true,
    modeLabel,
  };
}

function buildZScoreSlice(
  info: MetricInfo,
  rawValues: Float64Array,
  siblingGroups: SiblingGroup[],
  method: ZScoreMethod,
  zScoreLimit: number | undefined,
  theme: GrafanaTheme2
): MetricFrameSlice {
  const result = computeSpatialZScores(rawValues, siblingGroups, method);
  const configuredLimit =
    zScoreLimit === undefined ? DEFAULT_ZSCORE_LIMIT : Number.isFinite(zScoreLimit) && zScoreLimit > 0 ? zScoreLimit : 0;
  const fixed = configuredLimit > 0;
  const half = fixed ? configuredLimit : Math.max(1, result.maxAbs);
  const processor = buildZScoreProcessor(-half, half, info.field.config.decimals, theme);
  return {
    values: result.values,
    rawValues,
    zScoreStats: result.statsByCell,
    rangeInfo: {
      effectiveMin: -half,
      effectiveMax: half,
      minConfigured: fixed,
      maxConfigured: fixed,
      processor,
    },
    overridesCellRanges: true,
    modeLabel: method === 'median' ? 'Z-score (median)' : 'Z-score (mean)',
  };
}

/**
 * Evaluates active frame slices for all metrics.
 * Returns undefined in default 'value' mode when not scrubbing (keeping the legacy render path untouched).
 */
export function buildFrameSlices(args: BuildFrameSlicesArgs): Map<string, MetricFrameSlice> | undefined {
  const { colorMode, metricInfos, timeline, scrubIndex, theme, timeZone } = args;
  if (colorMode === 'value' && scrubIndex === null) {
    return undefined;
  }
  const out = new Map<string, MetricFrameSlice>();
  if (colorMode === 'value') {
    if (!timeline || scrubIndex === null) {
      return undefined;
    }
    for (const info of metricInfos) {
      out.set(
        info.refId,
        buildValueSlice(info, timeline, scrubIndex, args.timelineRangeInfosByRef?.get(info.refId), theme, timeZone)
      );
    }
    return out;
  }

  if (colorMode === 'delta') {
    const activeTime = timeline ? (scrubIndex ?? timeline.timestamps.length - 1) : -1;
    for (const info of metricInfos) {
      out.set(
        info.refId,
        buildDeltaSlice(
          info,
          timeline,
          activeTime,
          args.deltaLookbackSec,
          args.deltaRangeInfosByRef?.get(info.refId),
          theme
        )
      );
    }
    return out;
  }

  // colorMode === 'zscore'
  const groups = args.siblingGroups ?? [];
  for (const info of metricInfos) {
    let raw: Float64Array;
    if (timeline && scrubIndex !== null) {
      const C = timeline.cellCount;
      const full = timeline.valuesByRef.get(info.refId);
      raw = full ? full.subarray(scrubIndex * C, (scrubIndex + 1) * C) : new Float64Array(C).fill(Number.NaN);
    } else {
      raw = args.reducedArraysByRef?.get(info.refId) ?? new Float64Array(0);
    }
    out.set(info.refId, buildZScoreSlice(info, raw, groups, args.zScoreMethod, args.zScoreLimit, theme));
  }
  return out;
}
