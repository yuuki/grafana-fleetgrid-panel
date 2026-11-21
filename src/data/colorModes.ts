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

const ZERO_TEXT_RE = /^-?0(\.0+)?$/;

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
 * Builds a formatting-only Grafana DisplayProcessor that preserves unit and decimals
 * while stripping value mappings and thresholds (so raw-value mappings like "0 -> Idle"
 * never corrupt delta values or Z-score spread formatting).
 */
export function buildUnitOnlyProcessor(info: MetricInfo, theme: GrafanaTheme2, timeZone: string): DisplayProcessor {
  if (!info.field || !info.field.config) {
    return info.processor;
  }
  const field = {
    ...info.field,
    config: {
      ...info.field.config,
      mappings: [],
      thresholds: undefined,
    },
  };
  return getDisplayProcessor({ field, theme, timeZone });
}

function normalizeSignedDisplay(base: DisplayValue, num: number): { text: string; prefix?: string } {
  // Normalize near-zero rounded outputs ("-0.0" -> "0.0") and avoid "+0.0".
  if (ZERO_TEXT_RE.test(base.text)) {
    return {
      text: base.text.startsWith('-') ? base.text.slice(1) : base.text,
      prefix: base.prefix,
    };
  }
  if (num > 0 && !base.text.startsWith('+') && !base.text.startsWith('-')) {
    if (base.prefix && !base.prefix.startsWith('+') && !base.prefix.startsWith('-')) {
      return { text: base.text, prefix: `+${base.prefix}` };
    }
    return { text: `+${base.text}`, prefix: base.prefix };
  }
  return { text: base.text, prefix: base.prefix };
}

/**
 * Wraps a unit-only Grafana display processor so Temporal Delta values keep the metric's
 * configured unit and decimals, show an explicit '+' sign (before any prefix like '$'),
 * avoid '+0.0'/'-0.0', and use the diverging palette.
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
    const { text, prefix } = normalizeSignedDisplay(base, num);
    return {
      ...base,
      text,
      prefix,
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
  const digits =
    decimals != null && Number.isFinite(decimals) && decimals >= 0 ? Math.min(6, Math.floor(decimals)) : 1;
  return (value: unknown): DisplayValue => {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return { numeric: Number.NaN, text: '', color: undefined };
    }
    const fixed = num.toFixed(digits);
    let text: string;
    if (ZERO_TEXT_RE.test(fixed)) {
      text = fixed.startsWith('-') ? fixed.slice(1) : fixed;
    } else if (num > 0 && !fixed.startsWith('+')) {
      text = `+${fixed}`;
    } else {
      text = fixed;
    }
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
  if (n % 2 === 1) {
    return sorted[mid];
  }
  const a = sorted[mid - 1];
  const b = sorted[mid];
  // Overflow-safe midpoint even for values near Number.MAX_VALUE.
  const diff = b - a;
  return Number.isFinite(diff) ? a + diff / 2 : a / 2 + b / 2;
}

function safeMean(vals: number[]): number {
  let mean = 0;
  for (let i = 0; i < vals.length; i++) {
    // Incremental Welford mean avoids Float64 sum overflow for values near Number.MAX_VALUE.
    const step = vals[i] - mean;
    mean = Number.isFinite(step) ? mean + step / (i + 1) : mean * (i / (i + 1)) + vals[i] / (i + 1);
  }
  return mean;
}

function safeStdDev(vals: number[], mean: number): number {
  let maxDiff = 0;
  for (let i = 0; i < vals.length; i++) {
    const d = Math.abs(vals[i] - mean);
    if (Number.isFinite(d) && d > maxDiff) {
      maxDiff = d;
    }
  }
  if (maxDiff === 0) {
    return 0;
  }
  // Scale by maxDiff before squaring so values ~1e160..1e308 never overflow diff*diff to Infinity.
  let sqSum = 0;
  for (let i = 0; i < vals.length; i++) {
    const scaled = (vals[i] - mean) / maxDiff;
    sqSum += scaled * scaled;
  }
  return maxDiff * Math.sqrt(sqSum / vals.length);
}

function groupCenterAndSpread(vals: number[], method: ZScoreMethod): { center: number; spread: number } {
  if (method === 'median') {
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sortedMedian(sorted);
    const absDevs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = sortedMedian(absDevs);
    if (mad > 0 && Number.isFinite(MAD_TO_STD * mad)) {
      return { center: med, spread: MAD_TO_STD * mad };
    }
    // When >50% of siblings share the exact median, MAD is 0 even if an outlier exists;
    // fall back to scaled mean absolute deviation so outliers remain detectable.
    const meanAd = safeMean(absDevs);
    const scaled = MEAN_AD_TO_STD * meanAd;
    return { center: med, spread: meanAd > 0 && Number.isFinite(scaled) ? scaled : 0 };
  }
  const mean = safeMean(vals);
  return { center: mean, spread: safeStdDev(vals, mean) };
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
    if (!Number.isFinite(z)) {
      continue;
    }
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
      if (!Number.isFinite(d)) {
        continue;
      }
      values[c] = d;
      const absD = Math.abs(d);
      if (absD > maxAbs) {
        maxAbs = absD;
      }
    }
  }
  return { values, rawValues, baselineValues, prevIndex, maxAbs };
}

function scanSliceMaxAbsDelta(
  arr: Float64Array,
  currOffset: number,
  prevOffset: number,
  cellCount: number
): number {
  let maxAbs = 0;
  for (let c = 0; c < cellCount; c++) {
    const curr = arr[currOffset + c];
    const prev = arr[prevOffset + c];
    if (!Number.isFinite(curr) || !Number.isFinite(prev)) {
      continue;
    }
    const d = curr - prev;
    if (Number.isFinite(d)) {
      const absD = Math.abs(d);
      if (absD > maxAbs) {
        maxAbs = absD;
      }
    }
  }
  return maxAbs;
}

/**
 * Computes the maximum finite |v(t) - v(t - Δt)| across the entire timeline for one refId,
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
    const stepMax = scanSliceMaxAbsDelta(arr, t * C, prevIdx * C, C);
    if (stepMax > maxAbs) {
      maxAbs = stepMax;
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

function expandConstantAutoRange(min: number, max: number): { min: number; max: number } {
  if (min !== max) {
    return { min, max };
  }
  const step = Math.max(1, Math.abs(min) * Number.EPSILON);
  const up = min + step;
  if (Number.isFinite(up) && up > min) {
    return { min, max: up };
  }
  const down = min - step;
  if (Number.isFinite(down) && down < min) {
    return { min: down, max };
  }
  return { min: 0, max: 1 };
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
  const auto = expandConstantAutoRange(timelineRange.min, timelineRange.max);
  const normalized = normalizeEffectiveRange(
    info.minConfigured ? (info.configuredMin as number) : auto.min,
    info.maxConfigured ? (info.configuredMax as number) : auto.max,
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

/**
 * Builds symmetric diverging DisplayRangeInfos for Temporal Delta mode.
 * Raw Field Config min/max describe absolute metric ranges (often >= 0) and are NOT inherited,
 * so zero change is always pinned to neutral and negative changes always map to cool blue.
 */
export function buildDeltaRangeInfos(
  metricInfos: MetricInfo[],
  timeline: TimelineIndex | undefined,
  lookbackSec: number,
  theme: GrafanaTheme2,
  timeZone = 'browser'
): Map<string, DisplayRangeInfo> {
  const out = new Map<string, DisplayRangeInfo>();
  for (const info of metricInfos) {
    const globalMaxAbs = timeline ? computeTemporalDeltaGlobalMaxAbs(timeline, info.refId, lookbackSec) : 0;
    const safeHalf = globalMaxAbs > 0 && Number.isFinite(globalMaxAbs) ? globalMaxAbs : 1;
    const unitProc = buildUnitOnlyProcessor(info, theme, timeZone);
    out.set(info.refId, {
      effectiveMin: -safeHalf,
      effectiveMax: safeHalf,
      minConfigured: false,
      maxConfigured: false,
      processor: buildDeltaProcessor(unitProc, -safeHalf, safeHalf, theme),
    });
  }
  return out;
}

function computeGlobalZScoreMaxAbs(
  refId: string,
  timeline: TimelineIndex | undefined,
  reducedArraysByRef: Map<string, Float64Array> | undefined,
  siblingGroups: SiblingGroup[],
  method: ZScoreMethod
): number {
  let maxAbs = 0;
  const full = timeline?.valuesByRef.get(refId);
  if (timeline && full) {
    const C = timeline.cellCount;
    for (let t = 0; t < timeline.timestamps.length; t++) {
      const res = computeSpatialZScores(full.subarray(t * C, (t + 1) * C), siblingGroups, method);
      if (Number.isFinite(res.maxAbs) && res.maxAbs > maxAbs) {
        maxAbs = res.maxAbs;
      }
    }
  }
  const reduced = reducedArraysByRef?.get(refId);
  if (reduced) {
    const res = computeSpatialZScores(reduced, siblingGroups, method);
    if (Number.isFinite(res.maxAbs) && res.maxAbs > maxAbs) {
      maxAbs = res.maxAbs;
    }
  }
  return maxAbs;
}

/**
 * Precomputes stable symmetric diverging DisplayRangeInfos for Spatial Z-score mode.
 * Avoids rebuilding processors/gradients at 60 fps and keeps Auto (zScoreLimit=0) flicker-free during playback.
 */
export function buildZScoreRangeInfos(
  metricInfos: MetricInfo[],
  timeline: TimelineIndex | undefined,
  reducedArraysByRef: Map<string, Float64Array> | undefined,
  siblingGroups: SiblingGroup[],
  method: ZScoreMethod,
  zScoreLimit: number | undefined,
  theme: GrafanaTheme2
): Map<string, DisplayRangeInfo> {
  const out = new Map<string, DisplayRangeInfo>();
  const configuredLimit =
    zScoreLimit === undefined ? DEFAULT_ZSCORE_LIMIT : Number.isFinite(zScoreLimit) && zScoreLimit > 0 ? zScoreLimit : 0;
  const fixed = configuredLimit > 0;
  for (const info of metricInfos) {
    const half = fixed
      ? configuredLimit
      : Math.max(1, computeGlobalZScoreMaxAbs(info.refId, timeline, reducedArraysByRef, siblingGroups, method));
    const safeHalf = Number.isFinite(half) && half > 0 ? half : 1;
    out.set(info.refId, {
      effectiveMin: -safeHalf,
      effectiveMax: safeHalf,
      minConfigured: fixed,
      maxConfigured: fixed,
      processor: buildZScoreProcessor(-safeHalf, safeHalf, info.field?.config?.decimals, theme),
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
  /** Precomputed global Z-score ranges (avoids rebuilding processors and gradients on every scrub frame). */
  zScoreRangeInfosByRef?: Map<string, DisplayRangeInfo>;
  zScoreMethod: ZScoreMethod;
  zScoreLimit: number | undefined;
  siblingGroups?: SiblingGroup[];
  reducedArraysByRef?: Map<string, Float64Array>;
  theme: GrafanaTheme2;
  timeZone: string;
}

function buildValueSlices(args: BuildFrameSlicesArgs): Map<string, MetricFrameSlice> | undefined {
  const { timeline, scrubIndex, metricInfos, theme, timeZone } = args;
  if (!timeline || scrubIndex === null) {
    return undefined;
  }
  const C = timeline.cellCount;
  const out = new Map<string, MetricFrameSlice>();
  for (const info of metricInfos) {
    const full = timeline.valuesByRef.get(info.refId);
    const values = full ? full.subarray(scrubIndex * C, (scrubIndex + 1) * C) : new Float64Array(C).fill(Number.NaN);
    const rangeInfo =
      args.timelineRangeInfosByRef?.get(info.refId) ??
      buildTimelineValueRangeInfo(info, timeline.rangeByRef.get(info.refId), theme, timeZone);
    out.set(info.refId, { values, rangeInfo, overridesCellRanges: false });
  }
  return out;
}

function buildDeltaSliceForMetric(
  info: MetricInfo,
  timeline: TimelineIndex | undefined,
  activeTime: number,
  lookbackSec: number,
  cachedRangeInfo: DisplayRangeInfo | undefined,
  theme: GrafanaTheme2,
  timeZone: string
): MetricFrameSlice {
  const modeLabel = `Δ ${formatLookbackLabel(lookbackSec)}`;
  if (!timeline) {
    const unitProc = buildUnitOnlyProcessor(info, theme, timeZone);
    const rangeInfo = cachedRangeInfo ?? {
      effectiveMin: -1,
      effectiveMax: 1,
      minConfigured: false,
      maxConfigured: false,
      processor: buildDeltaProcessor(unitProc, -1, 1, theme),
    };
    return { values: new Float64Array(0), rangeInfo, overridesCellRanges: true, modeLabel };
  }
  const slice = computeTemporalDeltaSlice(timeline, info.refId, activeTime, lookbackSec);
  const safeHalf = slice.maxAbs > 0 && Number.isFinite(slice.maxAbs) ? slice.maxAbs : 1;
  const rangeInfo = cachedRangeInfo ?? {
    effectiveMin: -safeHalf,
    effectiveMax: safeHalf,
    minConfigured: false,
    maxConfigured: false,
    processor: buildDeltaProcessor(buildUnitOnlyProcessor(info, theme, timeZone), -safeHalf, safeHalf, theme),
  };
  return {
    values: slice.values,
    rawValues: slice.rawValues,
    baselineValues: slice.baselineValues,
    rangeInfo,
    overridesCellRanges: true,
    modeLabel,
  };
}

function buildDeltaSlices(args: BuildFrameSlicesArgs): Map<string, MetricFrameSlice> {
  const { timeline, scrubIndex, metricInfos, deltaLookbackSec, deltaRangeInfosByRef, theme, timeZone } = args;
  const activeTime = timeline ? (scrubIndex ?? timeline.timestamps.length - 1) : -1;
  const out = new Map<string, MetricFrameSlice>();
  for (const info of metricInfos) {
    out.set(
      info.refId,
      buildDeltaSliceForMetric(
        info,
        timeline,
        activeTime,
        deltaLookbackSec,
        deltaRangeInfosByRef?.get(info.refId),
        theme,
        timeZone
      )
    );
  }
  return out;
}

function rawSliceForZScore(
  refId: string,
  timeline: TimelineIndex | undefined,
  scrubIndex: number | null,
  reducedArraysByRef: Map<string, Float64Array> | undefined
): Float64Array {
  if (timeline && scrubIndex !== null) {
    const C = timeline.cellCount;
    const full = timeline.valuesByRef.get(refId);
    return full ? full.subarray(scrubIndex * C, (scrubIndex + 1) * C) : new Float64Array(C).fill(Number.NaN);
  }
  return reducedArraysByRef?.get(refId) ?? new Float64Array(0);
}

function buildZScoreSlices(args: BuildFrameSlicesArgs): Map<string, MetricFrameSlice> {
  const { metricInfos, timeline, scrubIndex, reducedArraysByRef, zScoreMethod, zScoreLimit, theme } = args;
  const groups = args.siblingGroups ?? [];
  const modeLabel = zScoreMethod === 'median' ? 'Z-score (median)' : 'Z-score (mean)';
  const configuredLimit =
    zScoreLimit === undefined ? DEFAULT_ZSCORE_LIMIT : Number.isFinite(zScoreLimit) && zScoreLimit > 0 ? zScoreLimit : 0;
  const fixed = configuredLimit > 0;
  const out = new Map<string, MetricFrameSlice>();
  for (const info of metricInfos) {
    const raw = rawSliceForZScore(info.refId, timeline, scrubIndex, reducedArraysByRef);
    const result = computeSpatialZScores(raw, groups, zScoreMethod);
    let rangeInfo = args.zScoreRangeInfosByRef?.get(info.refId);
    if (!rangeInfo) {
      const half = fixed ? configuredLimit : Math.max(1, Number.isFinite(result.maxAbs) ? result.maxAbs : 1);
      rangeInfo = {
        effectiveMin: -half,
        effectiveMax: half,
        minConfigured: fixed,
        maxConfigured: fixed,
        processor: buildZScoreProcessor(-half, half, info.field?.config?.decimals, theme),
      };
    }
    out.set(info.refId, {
      values: result.values,
      rawValues: raw,
      zScoreStats: result.statsByCell,
      rangeInfo,
      overridesCellRanges: true,
      modeLabel,
    });
  }
  return out;
}

/**
 * Evaluates active frame slices for all metrics.
 * Returns undefined in default 'value' mode when not scrubbing (keeping the legacy render path untouched).
 */
export function buildFrameSlices(args: BuildFrameSlicesArgs): Map<string, MetricFrameSlice> | undefined {
  if (args.colorMode === 'value') {
    return buildValueSlices(args);
  }
  if (args.colorMode === 'delta') {
    return buildDeltaSlices(args);
  }
  return buildZScoreSlices(args);
}
