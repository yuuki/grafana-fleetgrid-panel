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
  // 凡例・分割区画の並びを仕様の refId 順に固定する。buildMetricInfos は frame 走査順で
  // MetricInfo を作るため、data.series が targets 順と異なると並びが崩れる。refIds 順に整列する
  // (refIds に無い refId は末尾へ回し、Array.sort の安定性で相対順を保つ)。
  const orderByRef = new Map(refIds.map((r, i) => [r, i]));
  metricInfos.sort((a, b) => (orderByRef.get(a.refId) ?? Infinity) - (orderByRef.get(b.refId) ?? Infinity));
  return { root, warnings, metricInfos, refIds };
}
