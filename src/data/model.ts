import { DataFrame, GrafanaTheme2 } from '@grafana/data';
import { FleetGridOptions, HierarchyNode } from '../types';
import { normalizeFrames } from './normalize';
import { buildHierarchy } from './hierarchy';
import { attachCells, collectRefIds } from './values';
import { MetricInfo, buildMetricInfos } from './display';

export interface PanelModel {
  root: HierarchyNode;
  warnings: string[];
  metricInfos: MetricInfo[];
  refIds: string[];
}

export function buildModel(
  frames: DataFrame[],
  options: FleetGridOptions,
  theme: GrafanaTheme2,
  timeZone: string,
  targetRefIds: string[] = []
): PanelModel {
  const rows = normalizeFrames(frames, options.reduceCalc || 'lastNotNull');
  const { root, warnings } = buildHierarchy(rows, options.levels);
  // Keep the refIds of configured queries (leave a slot marked as missing even when the result has 0 series)
  const refIds = [...new Set([...targetRefIds, ...collectRefIds(rows)])];
  attachCells(root, rows, options.levels, options.spatialAggregation, refIds);

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
  return { root, warnings, metricInfos, refIds };
}
