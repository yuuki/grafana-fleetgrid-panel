import { DataFrame, GrafanaTheme2 } from '@grafana/data';
import { ClusterviewOptions, HierarchyNode } from '../types';
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
  options: ClusterviewOptions,
  theme: GrafanaTheme2,
  timeZone: string,
  targetRefIds: string[] = []
): PanelModel {
  const rows = normalizeFrames(frames, options.reduceCalc || 'lastNotNull');
  const { root, warnings } = buildHierarchy(rows, options.levels);
  // 設定済みクエリのrefIdを保持する(結果0系列でも欠損として枠を残す)
  const refIds = [...new Set([...targetRefIds, ...collectRefIds(rows)])];
  attachCells(root, rows, options.levels, options.spatialAggregation, refIds);

  // 色スケールは表示値(reduce・空間集約後のセル値)から計算する
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
  return { root, warnings, metricInfos, refIds };
}
