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
  // pathKey → { 代表原値ラベル, refId → 生値リスト }
  interface Bucket {
    labels: Record<string, string>;
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
      const rep: Record<string, string> = {};
      for (const level of levels) {
        rep[level.label] = row.labels[level.label];
      }
      bucket = { labels: rep, byRef: new Map() };
      buckets.set(pk, bucket);
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
      node.cell = { path: node.path, labels: bucket?.labels ?? {}, values };
      return;
    }
    node.children.forEach(visit);
  };
  visit(root);
}
