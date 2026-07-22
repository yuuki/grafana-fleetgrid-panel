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
  refIds: string[] = collectRefIds(rows),
  captureSourceLabels = false
): void {
  // pathKey → { all original label sets, refId → raw value list }
  interface Bucket {
    labelSets: Array<Record<string, string>>;
    seenLabelSets: Set<string>;
    byRef: Map<string, number[]>;
    sourceLabelSetsByRef?: Map<string, Array<Record<string, string>>>;
    seenSourceLabelSetsByRef?: Map<string, Set<string>>;
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
      bucket = {
        labelSets: [],
        seenLabelSets: new Set(),
        byRef: new Map(),
        sourceLabelSetsByRef: captureSourceLabels ? new Map() : undefined,
        seenSourceLabelSetsByRef: captureSourceLabels ? new Map() : undefined,
      };
      buckets.set(pk, bucket);
    }
    // Record all distinct original label sets whose extraction keys collide (duplicates are collapsed).
    // Example: even if node-a017 and node-b017 both extract to "017", both can still be searched via drilldown.
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
    if (captureSourceLabels) {
      const sourceKey = JSON.stringify(
        Object.entries(row.labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, value])
      );
      const seenSourceLabels = bucket.seenSourceLabelSetsByRef?.get(row.refId) ?? new Set<string>();
      if (!seenSourceLabels.has(sourceKey)) {
        seenSourceLabels.add(sourceKey);
        bucket.seenSourceLabelSetsByRef?.set(row.refId, seenSourceLabels);
        const sourceLabels = bucket.sourceLabelSetsByRef?.get(row.refId) ?? [];
        sourceLabels.push({ ...row.labels });
        bucket.sourceLabelSetsByRef?.set(row.refId, sourceLabels);
      }
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
      // labels is the representative original value for backward compatibility (the first set)
      node.cell = {
        path: node.path,
        labels: labelSets[0] ?? {},
        labelSets,
        ...(captureSourceLabels ? { sourceLabelSetsByRef: bucket?.sourceLabelSetsByRef ?? new Map() } : {}),
        values,
      };
      return;
    }
    node.children.forEach(visit);
  };
  visit(root);
}
