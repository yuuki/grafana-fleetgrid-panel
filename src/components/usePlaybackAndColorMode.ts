import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataFrame, GrafanaTheme2 } from '@grafana/data';
import { FleetGridOptions, ZScoreMethod, normalizeColorMode, normalizeZScoreMethod } from '../types';
import { DisplayRangeInfo } from '../data/cellRange';
import {
  MetricFrameSlice,
  buildDeltaRangeInfos,
  buildFrameSlices,
  buildSiblingGroups,
  buildTimelineRangeInfos,
  extractReducedValueArrays,
} from '../data/colorModes';
import { pathKey } from '../data/hierarchy';
import { PanelModel } from '../data/model';
import { TimelineIndex, buildTimelineIndex, collectLeafCellIndices } from '../data/timeline';
import { LayoutResult } from '../layout/layout';
import { DEFAULT_PLAYBACK_SPEED } from './TimeScrubber';

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
  extraWarnings: string[];
  onTogglePlay: () => void;
  onScrub: (index: number) => void;
  onStep: (delta: number) => void;
  onSpeedChange: (speed: number) => void;
  onResetLive: () => void;
}

export function buildCellIndexByLayout(layout: LayoutResult, cellIndexByPath: Map<string, number>): Int32Array {
  const arr = new Int32Array(layout.cells.length);
  for (let i = 0; i < layout.cells.length; i++) {
    arr[i] = cellIndexByPath.get(pathKey(layout.cells[i].cell.path)) ?? -1;
  }
  return arr;
}

function buildEffectiveRangeInfos(
  model: PanelModel,
  frameSlicesByRef: Map<string, MetricFrameSlice> | undefined
): Map<string, DisplayRangeInfo[]> {
  if (!frameSlicesByRef) {
    return model.rangeInfosByRef;
  }
  const out = new Map<string, DisplayRangeInfo[]>();
  for (const info of model.metricInfos) {
    const slice = frameSlicesByRef.get(info.refId);
    const base = model.rangeInfosByRef.get(info.refId);
    if (!slice) {
      if (base) {
        out.set(info.refId, base);
      }
      continue;
    }
    if (slice.overridesCellRanges || (base?.length ?? 0) <= 1) {
      out.set(info.refId, [slice.rangeInfo]);
    } else if (base) {
      out.set(info.refId, base);
    }
  }
  return out;
}

function buildModeLabels(frameSlicesByRef: Map<string, MetricFrameSlice> | undefined): Map<string, string> | undefined {
  if (!frameSlicesByRef) {
    return undefined;
  }
  const labels = new Map<string, string>();
  for (const [refId, slice] of frameSlicesByRef) {
    if (slice.modeLabel) {
      labels.set(refId, slice.modeLabel);
    }
  }
  return labels.size > 0 ? labels : undefined;
}

function collectModeWarnings(colorMode: string, timeline: TimelineIndex | undefined): string[] {
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
        ? buildDeltaRangeInfos(model.metricInfos, timeline, deltaLookbackSec, theme)
        : undefined,
    [colorMode, model.metricInfos, timeline, deltaLookbackSec, theme]
  );

  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [stepsPerSec, setStepsPerSec] = useState<number>(DEFAULT_PLAYBACK_SPEED);

  const showScrubber = Boolean(options.enablePlayback) && Boolean(timeline);
  const maxIndex = timeline ? timeline.timestamps.length - 1 : 0;
  const effectiveScrubIndex =
    timeline && scrubIndex !== null ? Math.max(0, Math.min(maxIndex, scrubIndex)) : null;
  const effectivePlaying = isPlaying && showScrubber;
  const activeTimeIndex = effectiveScrubIndex ?? maxIndex;

  // Keep latest active index in a ref so the RAF loop doesn't restart on every frame tick.
  const indexRef = useRef(activeTimeIndex);
  useEffect(() => {
    indexRef.current = activeTimeIndex;
  }, [activeTimeIndex]);

  useEffect(() => {
    if (!effectivePlaying || !timeline) {
      return undefined;
    }
    const lastIdx = timeline.timestamps.length - 1;
    const stepMs = 1000 / Math.max(1, stepsPerSec);
    let rafId = 0;
    let lastTick = performance.now();

    const tick = (now: number) => {
      const elapsed = now - lastTick;
      if (elapsed >= stepMs) {
        const steps = Math.max(1, Math.floor(elapsed / stepMs));
        lastTick += steps * stepMs;
        const next = Math.min(lastIdx, indexRef.current + steps);
        indexRef.current = next;
        setScrubIndex(next);
        if (next >= lastIdx) {
          setIsPlaying(false);
          return;
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [effectivePlaying, timeline, stepsPerSec]);

  const onTogglePlay = useCallback(() => {
    if (!timeline) {
      return;
    }
    setIsPlaying((playing) => {
      if (playing) {
        return false;
      }
      const lastIdx = timeline.timestamps.length - 1;
      if (indexRef.current >= lastIdx || scrubIndex === null) {
        indexRef.current = 0;
        setScrubIndex(0);
      }
      return true;
    });
  }, [timeline, scrubIndex]);

  const onScrub = useCallback(
    (index: number) => {
      if (!timeline) {
        return;
      }
      const clamped = Math.max(0, Math.min(timeline.timestamps.length - 1, Math.round(index)));
      setIsPlaying(false);
      setScrubIndex(clamped);
    },
    [timeline]
  );

  const onStep = useCallback(
    (delta: number) => {
      if (!timeline) {
        return;
      }
      setIsPlaying(false);
      setScrubIndex((prev) => {
        const base = prev ?? timeline.timestamps.length - 1;
        return Math.max(0, Math.min(timeline.timestamps.length - 1, base + delta));
      });
    },
    [timeline]
  );

  const onResetLive = useCallback(() => {
    setIsPlaying(false);
    setScrubIndex(null);
  }, []);

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
      zScoreMethod,
      options.zScoreLimit,
      siblingGroups,
      reducedArraysByRef,
      theme,
      timeZone,
    ]
  );

  const effectiveRangeInfosByRef = useMemo(
    () => buildEffectiveRangeInfos(model, frameSlicesByRef),
    [model, frameSlicesByRef]
  );
  const modeLabelsByRef = useMemo(() => buildModeLabels(frameSlicesByRef), [frameSlicesByRef]);
  const extraWarnings = useMemo(() => collectModeWarnings(colorMode, timeline), [colorMode, timeline]);

  return {
    timeline,
    showScrubber,
    activeTimeIndex,
    isScrubbing: effectiveScrubIndex !== null,
    isPlaying: effectivePlaying,
    stepsPerSec,
    zScoreMethod,
    cellIndexByPath,
    frameSlicesByRef,
    effectiveRangeInfosByRef,
    modeLabelsByRef,
    extraWarnings,
    onTogglePlay,
    onScrub,
    onStep,
    onSpeedChange: setStepsPerSec,
    onResetLive,
  };
}
