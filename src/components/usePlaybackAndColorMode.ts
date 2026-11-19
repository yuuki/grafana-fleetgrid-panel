import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataFrame, DisplayProcessor, GrafanaTheme2 } from '@grafana/data';
import { CellRangeInfo, ColorMode, FleetGridOptions, ZScoreMethod, normalizeColorMode, normalizeZScoreMethod } from '../types';
import { DisplayRangeInfo } from '../data/cellRange';
import {
  MetricFrameSlice,
  buildDeltaRangeInfos,
  buildFrameSlices,
  buildSiblingGroups,
  buildTimelineRangeInfos,
  buildUnitOnlyProcessor,
  buildZScoreRangeInfos,
  extractReducedValueArrays,
  formatLookbackLabel,
} from '../data/colorModes';
import { pathKey } from '../data/hierarchy';
import { PanelModel } from '../data/model';
import { TimelineIndex, buildTimelineIndex, collectLeafCellIndices } from '../data/timeline';
import { LayoutResult } from '../layout/layout';
import { DEFAULT_PLAYBACK_SPEED } from './TimeScrubber';

/** Elapsed gap (ms) treated as a background-tab pause rather than catch-up burst. */
const BACKGROUND_RESUME_MS = 1000;
/** Tolerance (ms) so 60/s playback aligns cleanly with 60 Hz RAF cadence (~16.6ms). */
const RAF_JITTER_TOLERANCE_MS = 1;

export interface PlaybackAndColorState {
  timeline: TimelineIndex | undefined;
  showScrubber: boolean;
  /** Current timestamp index shown in the scrubber (0..T-1). */
  activeTimeIndex: number;
  /** True when the user has scrubbed/played away from the reduced view. */
  isScrubbing: boolean;
  isPlaying: boolean;
  stepsPerSec: number;
  zScoreMethod: ZScoreMethod;
  cellIndexByPath: Map<string, number>;
  frameSlicesByRef: Map<string, MetricFrameSlice> | undefined;
  effectiveRangeInfosByRef: Map<string, DisplayRangeInfo[]>;
  modeLabelsByRef: Map<string, string> | undefined;
  unitOnlyProcessorsByRef: Map<string, DisplayProcessor> | undefined;
  extraWarnings: string[];
  onTogglePlay: () => void;
  onScrub: (index: number) => void;
  onStep: (delta: number) => void;
  onSpeedChange: (speed: number) => void;
  onResetLive: () => void;
}

interface PlaybackCursorState {
  /** Timeline instance this cursor belongs to; a new timeline resets scrub/play cleanly without effects. */
  timeline: TimelineIndex | undefined;
  /** Whether scrubber was enabled when playback started; disabling scrubber stops playback cleanly. */
  scrubberEnabled: boolean;
  scrubIndex: number | null;
  isPlaying: boolean;
}

export function buildCellIndexByLayout(layout: LayoutResult, cellIndexByPath: Map<string, number>): Int32Array {
  const arr = new Int32Array(layout.cells.length);
  for (let i = 0; i < layout.cells.length; i++) {
    arr[i] = cellIndexByPath.get(pathKey(layout.cells[i].cell.path)) ?? -1;
  }
  return arr;
}

function hasOverrideRange(ranges: DisplayRangeInfo[] | undefined): boolean {
  if (!ranges) {
    return false;
  }
  return ranges.some((r) => (r as Partial<CellRangeInfo>).source === 'override');
}

function buildStableEffectiveRangeInfos(
  model: PanelModel,
  colorMode: ColorMode,
  isScrubbing: boolean,
  timelineRangeInfosByRef: Map<string, DisplayRangeInfo> | undefined,
  deltaRangeInfosByRef: Map<string, DisplayRangeInfo> | undefined,
  zScoreRangeInfosByRef: Map<string, DisplayRangeInfo> | undefined
): Map<string, DisplayRangeInfo[]> {
  if (colorMode === 'value' && !isScrubbing) {
    return model.rangeInfosByRef;
  }
  const activeRanges =
    colorMode === 'delta'
      ? deltaRangeInfosByRef
      : colorMode === 'zscore'
        ? zScoreRangeInfosByRef
        : timelineRangeInfosByRef;
  if (!activeRanges) {
    return model.rangeInfosByRef;
  }
  const overridesCellRanges = colorMode !== 'value';
  const out = new Map<string, DisplayRangeInfo[]>();
  for (const info of model.metricInfos) {
    const base = model.rangeInfosByRef.get(info.refId);
    const rangeInfo = activeRanges.get(info.refId);
    if (!rangeInfo) {
      if (base) {
        out.set(info.refId, base);
      }
      continue;
    }
    // In value mode, keep label-override legends intact (even single-rule overrides) so the header matches the canvas.
    if (overridesCellRanges || !hasOverrideRange(base)) {
      out.set(info.refId, [rangeInfo]);
    } else if (base) {
      out.set(info.refId, base);
    }
  }
  return out;
}

function buildStableModeLabels(
  model: PanelModel,
  colorMode: ColorMode,
  deltaLookbackSec: number,
  zScoreMethod: ZScoreMethod
): Map<string, string> | undefined {
  if (colorMode === 'value') {
    return undefined;
  }
  const label =
    colorMode === 'delta'
      ? `Δ ${formatLookbackLabel(deltaLookbackSec)}`
      : zScoreMethod === 'median'
        ? 'Z-score (median)'
        : 'Z-score (mean)';
  const out = new Map<string, string>();
  for (const info of model.metricInfos) {
    out.set(info.refId, label);
  }
  return out.size > 0 ? out : undefined;
}

function collectModeWarnings(colorMode: ColorMode, timeline: TimelineIndex | undefined): string[] {
  const warnings: string[] = [];
  if (colorMode === 'delta' && !timeline) {
    warnings.push('Delta color mode requires time-series data with at least two timestamps.');
  }
  if (timeline?.downsampled) {
    warnings.push(
      `Timeline downsampled from ${timeline.rawTimestampCount} to ${timeline.timestamps.length} timestamps to stay within memory limits.`
    );
  }
  return warnings;
}

function resolveCursor(
  cursor: PlaybackCursorState,
  timeline: TimelineIndex | undefined,
  showScrubber: boolean
): { scrubIndex: number | null; isPlaying: boolean } {
  if (!timeline || cursor.timeline !== timeline) {
    return { scrubIndex: null, isPlaying: false };
  }
  const maxIndex = timeline.timestamps.length - 1;
  const scrubIndex = cursor.scrubIndex !== null ? Math.max(0, Math.min(maxIndex, cursor.scrubIndex)) : null;
  const isPlaying = showScrubber && cursor.scrubberEnabled && cursor.isPlaying;
  return { scrubIndex, isPlaying };
}

function advanceCursor(
  prev: PlaybackCursorState,
  timeline: TimelineIndex,
  showScrubber: boolean,
  steps: number
): PlaybackCursorState {
  if (!showScrubber || prev.timeline !== timeline || !prev.isPlaying) {
    return prev;
  }
  const lastIdx = timeline.timestamps.length - 1;
  const current = prev.scrubIndex !== null ? Math.max(0, Math.min(lastIdx, prev.scrubIndex)) : 0;
  const next = Math.min(lastIdx, current + steps);
  return {
    timeline,
    scrubberEnabled: true,
    scrubIndex: next,
    isPlaying: next < lastIdx,
  };
}

export function usePlaybackAndColorMode(
  frames: DataFrame[],
  model: PanelModel,
  options: FleetGridOptions,
  theme: GrafanaTheme2,
  timeZone: string
): PlaybackAndColorState {
  const colorMode = normalizeColorMode(options.colorMode);
  const zScoreMethod = normalizeZScoreMethod(options.zScoreMethod);
  const deltaLookbackSec = options.deltaLookbackSec ?? 0;
  const needsTimeline = Boolean(options.enablePlayback) || colorMode === 'delta';

  const timeline = useMemo(
    () =>
      needsTimeline
        ? buildTimelineIndex(frames, model.root, options.levels, options.spatialAggregation, model.refIds)
        : undefined,
    [needsTimeline, frames, model.root, options.levels, options.spatialAggregation, model.refIds]
  );

  const cellIndexByPath = useMemo(
    () => timeline?.cellIndexByPath ?? collectLeafCellIndices(model.root, options.levels.length),
    [timeline, model.root, options.levels.length]
  );

  const siblingGroups = useMemo(
    () =>
      colorMode === 'zscore'
        ? buildSiblingGroups(model.root, options.levels.length, cellIndexByPath, options.zScoreGroupDepth)
        : undefined,
    [colorMode, model.root, options.levels.length, cellIndexByPath, options.zScoreGroupDepth]
  );

  const reducedArraysByRef = useMemo(
    () =>
      colorMode === 'zscore'
        ? extractReducedValueArrays(model.root, options.levels.length, cellIndexByPath, model.refIds)
        : undefined,
    [colorMode, model.root, options.levels.length, cellIndexByPath, model.refIds]
  );

  const timelineRangeInfosByRef = useMemo(
    () =>
      timeline && colorMode === 'value'
        ? buildTimelineRangeInfos(model.metricInfos, timeline, theme, timeZone)
        : undefined,
    [timeline, colorMode, model.metricInfos, theme, timeZone]
  );

  const deltaRangeInfosByRef = useMemo(
    () =>
      colorMode === 'delta'
        ? buildDeltaRangeInfos(model.metricInfos, timeline, deltaLookbackSec, theme, timeZone)
        : undefined,
    [colorMode, model.metricInfos, timeline, deltaLookbackSec, theme, timeZone]
  );

  const zScoreRangeInfosByRef = useMemo(
    () =>
      colorMode === 'zscore'
        ? buildZScoreRangeInfos(
            model.metricInfos,
            timeline,
            reducedArraysByRef,
            siblingGroups ?? [],
            zScoreMethod,
            options.zScoreLimit,
            theme
          )
        : undefined,
    [colorMode, model.metricInfos, timeline, reducedArraysByRef, siblingGroups, zScoreMethod, options.zScoreLimit, theme]
  );

  const unitOnlyProcessorsByRef = useMemo(() => {
    if (colorMode === 'value') {
      return undefined;
    }
    return new Map(model.metricInfos.map((info) => [info.refId, buildUnitOnlyProcessor(info, theme, timeZone)]));
  }, [colorMode, model.metricInfos, theme, timeZone]);

  const [cursor, setCursor] = useState<PlaybackCursorState>({
    timeline: undefined,
    scrubberEnabled: false,
    scrubIndex: null,
    isPlaying: false,
  });
  const [stepsPerSec, setStepsPerSec] = useState<number>(DEFAULT_PLAYBACK_SPEED);

  const showScrubber = Boolean(options.enablePlayback) && Boolean(timeline);
  const maxIndex = timeline ? timeline.timestamps.length - 1 : 0;
  const { scrubIndex: effectiveScrubIndex, isPlaying: effectivePlaying } = resolveCursor(cursor, timeline, showScrubber);
  const activeTimeIndex = effectiveScrubIndex ?? maxIndex;
  const isScrubbing = effectiveScrubIndex !== null;

  useEffect(() => {
    if (!showScrubber) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCursor((prev) => (prev.isPlaying ? { ...prev, isPlaying: false } : prev));
    }
  }, [showScrubber]);

  useEffect(() => {
    if (!effectivePlaying || !timeline) {
      return undefined;
    }
    const stepMs = 1000 / Math.max(1, stepsPerSec);
    let rafId = 0;
    let lastTick = performance.now();

    const tick = (now: number) => {
      const elapsed = now - lastTick;
      if (elapsed > BACKGROUND_RESUME_MS) {
        // After a long pause (e.g. backgrounded browser tab), advance cleanly by 1 step instead of teleporting.
        lastTick = now;
        setCursor((prev) => advanceCursor(prev, timeline, showScrubber, 1));
      } else if (elapsed + RAF_JITTER_TOLERANCE_MS >= stepMs) {
        const steps = Math.max(1, Math.floor((elapsed + RAF_JITTER_TOLERANCE_MS) / stepMs));
        lastTick = Math.min(now, lastTick + steps * stepMs);
        setCursor((prev) => advanceCursor(prev, timeline, showScrubber, steps));
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [effectivePlaying, timeline, showScrubber, stepsPerSec]);

  const onTogglePlay = useCallback(() => {
    if (!timeline || !showScrubber) {
      return;
    }
    const lastIdx = timeline.timestamps.length - 1;
    setCursor((prev) => {
      const current = resolveCursor(prev, timeline, showScrubber);
      if (current.isPlaying) {
        return { timeline, scrubberEnabled: true, scrubIndex: current.scrubIndex, isPlaying: false };
      }
      const startIndex = current.scrubIndex === null || current.scrubIndex >= lastIdx ? 0 : current.scrubIndex;
      return { timeline, scrubberEnabled: true, scrubIndex: startIndex, isPlaying: true };
    });
  }, [timeline, showScrubber]);

  const onScrub = useCallback(
    (index: number) => {
      if (!timeline || !Number.isFinite(index)) {
        return;
      }
      const clamped = Math.max(0, Math.min(timeline.timestamps.length - 1, Math.round(index)));
      setCursor({ timeline, scrubberEnabled: showScrubber, scrubIndex: clamped, isPlaying: false });
    },
    [timeline, showScrubber]
  );

  const onStep = useCallback(
    (delta: number) => {
      if (!timeline || !Number.isFinite(delta)) {
        return;
      }
      const lastIdx = timeline.timestamps.length - 1;
      setCursor((prev) => {
        const current = resolveCursor(prev, timeline, showScrubber);
        const base = current.scrubIndex ?? lastIdx;
        const next = Math.max(0, Math.min(lastIdx, base + Math.trunc(delta)));
        return { timeline, scrubberEnabled: showScrubber, scrubIndex: next, isPlaying: false };
      });
    },
    [timeline, showScrubber]
  );

  const onResetLive = useCallback(() => {
    setCursor({ timeline, scrubberEnabled: showScrubber, scrubIndex: null, isPlaying: false });
  }, [timeline, showScrubber]);

  const frameSlicesByRef = useMemo(
    () =>
      buildFrameSlices({
        colorMode,
        metricInfos: model.metricInfos,
        timeline,
        scrubIndex: effectiveScrubIndex,
        deltaLookbackSec,
        timelineRangeInfosByRef,
        deltaRangeInfosByRef,
        zScoreRangeInfosByRef,
        zScoreMethod,
        zScoreLimit: options.zScoreLimit,
        siblingGroups,
        reducedArraysByRef,
        theme,
        timeZone,
      }),
    [
      colorMode,
      model.metricInfos,
      timeline,
      effectiveScrubIndex,
      deltaLookbackSec,
      timelineRangeInfosByRef,
      deltaRangeInfosByRef,
      zScoreRangeInfosByRef,
      zScoreMethod,
      options.zScoreLimit,
      siblingGroups,
      reducedArraysByRef,
      theme,
      timeZone,
    ]
  );

  // Derived from stable precomputed range maps (NOT frameSlicesByRef), so scrubbing at 60 fps
  // preserves referential equality for PanelHeader / RangeLegend / SplitLegend.
  const effectiveRangeInfosByRef = useMemo(
    () =>
      buildStableEffectiveRangeInfos(
        model,
        colorMode,
        isScrubbing,
        timelineRangeInfosByRef,
        deltaRangeInfosByRef,
        zScoreRangeInfosByRef
      ),
    [model, colorMode, isScrubbing, timelineRangeInfosByRef, deltaRangeInfosByRef, zScoreRangeInfosByRef]
  );

  const modeLabelsByRef = useMemo(
    () => buildStableModeLabels(model, colorMode, deltaLookbackSec, zScoreMethod),
    [model, colorMode, deltaLookbackSec, zScoreMethod]
  );

  const extraWarnings = useMemo(() => collectModeWarnings(colorMode, timeline), [colorMode, timeline]);

  return {
    timeline,
    showScrubber,
    activeTimeIndex,
    isScrubbing,
    isPlaying: effectivePlaying,
    stepsPerSec,
    zScoreMethod,
    cellIndexByPath,
    frameSlicesByRef,
    effectiveRangeInfosByRef,
    modeLabelsByRef,
    unitOnlyProcessorsByRef,
    extraWarnings,
    onTogglePlay,
    onScrub,
    onStep,
    onSpeedChange: setStepsPerSec,
    onResetLive,
  };
}
