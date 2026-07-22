import { DataFrame, GrafanaTheme2, getDisplayProcessor } from '@grafana/data';
import { CellRangeInfo, FleetGridOptions, HierarchyNode } from '../types';
import { normalizeFrames } from './normalize';
import { buildHierarchy } from './hierarchy';
import { attachCells, collectRefIds } from './values';
import { MetricInfo, buildMetricInfos, normalizeEffectiveRange } from './display';
import { compileRangeOverrides, resolveCellRangeOverride } from './rangeOverrides';
import { DisplayRangeInfo, rangeSignature } from './cellRange';

export interface PanelModel {
  root: HierarchyNode;
  warnings: string[];
  metricInfos: MetricInfo[];
  refIds: string[];
  rangeInfosByRef: Map<string, DisplayRangeInfo[]>;
}

export function buildModel(
  frames: DataFrame[],
  options: FleetGridOptions,
  theme: GrafanaTheme2,
  timeZone: string,
  targetRefIds: string[] = []
): PanelModel {
  const compiledOverrides = compileRangeOverrides(options.rangeOverrides);
  const rows = normalizeFrames(frames, options.reduceCalc || 'lastNotNull');
  const { root, warnings } = buildHierarchy(rows, options.levels);
  // Keep the refIds of configured queries (leave a slot marked as missing even when the result has 0 series)
  const refIds = [...new Set([...targetRefIds, ...collectRefIds(rows)])];
  attachCells(root, rows, options.levels, options.spatialAggregation, refIds, compiledOverrides.length > 0);

  // The color scale is computed from the display value (the cell value after reduce and spatial aggregation)
  const ranges = new Map<string, { min: number; max: number }>();
  const visit = (node: HierarchyNode) => {
    node.children.forEach(visit);
    if (!node.cell) {
      return;
    }
    for (const [refId, v] of node.cell.values) {
      if (v === null) {
        continue;
      }
      const r = ranges.get(refId) ?? { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
      r.min = Math.min(r.min, v);
      r.max = Math.max(r.max, v);
      ranges.set(refId, r);
    }
  };
  visit(root);

  const metricInfos = buildMetricInfos(frames, theme, timeZone, ranges);
  // Fix the legend/split-zone order to the refId order per spec. buildMetricInfos builds MetricInfo
  // in frame-scan order, so the order breaks if data.series differs from the targets order. Sort by refIds order
  // (a refId not in refIds is pushed to the end, relying on Array.sort's stability to preserve relative order).
  const orderByRef = new Map(refIds.map((r, i) => [r, i]));
  metricInfos.sort((a, b) => (orderByRef.get(a.refId) ?? Infinity) - (orderByRef.get(b.refId) ?? Infinity));

  const rangeInfosByRef = new Map<string, DisplayRangeInfo[]>();
  const rangeSignaturesByRef = new Map<string, Set<string>>();
  const addRangeInfo = (refId: string, range: DisplayRangeInfo) => {
    const signatures = rangeSignaturesByRef.get(refId) ?? new Set<string>();
    const signature = rangeSignature(range);
    if (signatures.has(signature)) {
      return;
    }
    signatures.add(signature);
    rangeSignaturesByRef.set(refId, signatures);
    rangeInfosByRef.set(refId, [...(rangeInfosByRef.get(refId) ?? []), range]);
  };
  const standardByRef = new Map<string, CellRangeInfo>(
    metricInfos.map((info) => [
      info.refId,
      {
        effectiveMin: info.effectiveMin,
        effectiveMax: info.effectiveMax,
        minConfigured: info.minConfigured,
        maxConfigured: info.maxConfigured,
        processor: info.processor,
        source: 'standard',
      },
    ])
  );

  if (compiledOverrides.length === 0) {
    for (const [refId, standard] of standardByRef) {
      if (ranges.has(refId)) {
        addRangeInfo(refId, standard);
      }
    }
    return { root, warnings, metricInfos, refIds, rangeInfosByRef };
  }
  const infoByRef = new Map(metricInfos.map((info) => [info.refId, info]));
  const processorCache = new Map<string, CellRangeInfo>();
  for (const info of metricInfos) {
    processorCache.set(`${info.refId}\0${info.effectiveMin}\0${info.effectiveMax}`, {
      effectiveMin: info.effectiveMin,
      effectiveMax: info.effectiveMax,
      minConfigured: info.minConfigured,
      maxConfigured: info.maxConfigured,
      processor: info.processor,
      source: 'standard',
    });
  }
  const conflicts = new Map<string, { count: number; paths: string[] }>();
  const attachRanges = (node: HierarchyNode) => {
    node.children.forEach(attachRanges);
    if (!node.cell) {
      return;
    }
    for (const [refId, info] of infoByRef) {
      if (node.cell.values.get(refId) == null) {
        continue;
      }
      const resolution = resolveCellRangeOverride(
        compiledOverrides,
        refId,
        node.cell.sourceLabelSetsByRef?.get(refId) ?? []
      );
      if (resolution.status !== 'matched') {
        const standard = standardByRef.get(refId)!;
        addRangeInfo(refId, standard);
        if (resolution.status === 'conflict') {
          node.cell.ranges ??= new Map();
          node.cell.ranges.set(refId, { ...standard, source: 'conflict' });
          const conflict = conflicts.get(refId) ?? { count: 0, paths: [] };
          conflict.count += 1;
          if (conflict.paths.length < 3) {
            conflict.paths.push(node.path.join(' / '));
          }
          conflicts.set(refId, conflict);
        }
        continue;
      }

      const override = resolution.rule.override;
      const minConfigured = override.min !== undefined || info.minConfigured;
      const maxConfigured = override.max !== undefined || info.maxConfigured;
      const normalized = normalizeEffectiveRange(
        override.min ?? info.configuredMin ?? info.autoMin ?? info.effectiveMin,
        override.max ?? info.configuredMax ?? info.autoMax ?? info.effectiveMax,
        minConfigured,
        maxConfigured,
        override.min !== undefined && override.max === undefined
          ? 'min'
          : override.max !== undefined && override.min === undefined
            ? 'max'
            : undefined
      );
      const cacheKey = `${refId}\0${normalized.min}\0${normalized.max}`;
      let cached = processorCache.get(cacheKey);
      if (!cached) {
        const delta = normalized.max - normalized.min;
        const field = {
          ...info.field,
          config: { ...info.field.config, min: normalized.min, max: normalized.max },
          state: { ...info.field.state, range: { min: normalized.min, max: normalized.max, delta } },
        };
        cached = {
          effectiveMin: normalized.min,
          effectiveMax: normalized.max,
          minConfigured,
          maxConfigured,
          processor: getDisplayProcessor({ field, theme, timeZone }),
          source: 'override',
        };
        processorCache.set(cacheKey, cached);
      }
      const resolved: CellRangeInfo = {
        ...cached,
        source: 'override',
        minConfigured,
        maxConfigured,
        matchedRuleIndex: resolution.rule.index,
        matchers: override.matchers,
      };
      node.cell.ranges ??= new Map();
      node.cell.ranges.set(refId, resolved);
      addRangeInfo(refId, resolved);
    }
  };
  attachRanges(root);
  for (const [refId, conflict] of conflicts) {
    warnings.push(
      `Label range override conflict for refId "${refId}": ${conflict.count} cell(s) use the standard range (paths: ${conflict.paths.join(', ')})`
    );
  }
  return { root, warnings, metricInfos, refIds, rangeInfosByRef };
}
