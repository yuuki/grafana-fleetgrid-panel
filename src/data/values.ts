import { HierarchyNode, LevelDef, NormalizedRow, SpatialAggregation } from '../types';
import { extractKey, pathKey } from './hierarchy';

export function collectRefIds(rows: NormalizedRow[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    if (!seen.includes(row.refId)) {
      seen.push(row.refId);
    }
  }
  return seen;
}

function aggregate(values: number[], agg: SpatialAggregation): number {
  switch (agg) {
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

export function attachCells(
  root: HierarchyNode,
  rows: NormalizedRow[],
  levels: LevelDef[],
  agg: SpatialAggregation,
  refIds: string[] = collectRefIds(rows)
): void {
  // pathKey → { 全原値ラベル組, refId → 生値リスト }
  interface Bucket {
    labelSets: Array<Record<string, string>>;
    seenLabelSets: Set<string>;
    byRef: Map<string, number[]>;
  }
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const path: string[] = [];
    let ok = true;
    for (const level of levels) {
      const raw = row.labels[level.label];
      const key = raw === undefined ? null : extractKey(raw, level);
      if (key === null) {
        ok = false;
        break;
      }
      path.push(key);
    }
    if (!ok) {
      continue;
    }
    const pk = pathKey(path);
    let bucket = buckets.get(pk);
    if (!bucket) {
      bucket = { labelSets: [], seenLabelSets: new Set(), byRef: new Map() };
      buckets.set(pk, bucket);
    }
    // 抽出キーが衝突する異なる原値組をすべて記録する(重複は畳む)。
    // 例: node-a017 と node-b017 が同じ "017" に抽出されても両方をドリルダウンで探索できる。
    const rep: Record<string, string> = {};
    for (const level of levels) {
      rep[level.label] = row.labels[level.label];
    }
    const repKey = pathKey(levels.map((l) => rep[l.label]));
    if (!bucket.seenLabelSets.has(repKey)) {
      bucket.seenLabelSets.add(repKey);
      bucket.labelSets.push(rep);
    }
    if (row.value === null) {
      continue;
    }
    const list = bucket.byRef.get(row.refId) ?? [];
    list.push(row.value);
    bucket.byRef.set(row.refId, list);
  }

  const visit = (node: HierarchyNode) => {
    if (node.children.length === 0 && node.path.length === levels.length) {
      const bucket = buckets.get(pathKey(node.path));
      const values = new Map<string, number | null>();
      for (const refId of refIds) {
        const list = bucket?.byRef.get(refId);
        values.set(refId, list && list.length > 0 ? aggregate(list, agg) : null);
      }
      const labelSets = bucket?.labelSets ?? [];
      // labels は後方互換の代表原値(先頭の組)
      node.cell = { path: node.path, labels: labelSets[0] ?? {}, labelSets, values };
      return;
    }
    node.children.forEach(visit);
  };
  visit(root);
}
