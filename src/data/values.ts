import { CellModel, HierarchyNode, LevelDef, NormalizedRow, SpatialAggregation } from '../types';
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

// pathKey → { all original label sets, refId → raw value list }
interface Bucket {
  labelSets: Array<Record<string, string>>;
  seenLabelSets: Set<string>;
  byRef: Map<string, number[]>;
  sourceLabelSetsByRef?: Map<string, Array<Record<string, string>>>;
  seenSourceLabelSetsByRef?: Map<string, Set<string>>;
  labelValues?: Map<string, Set<string>>;
}

interface CellOptions {
  levels: LevelDef[];
  agg: SpatialAggregation;
  refIds: string[];
  captureSourceLabels: boolean;
  extraLabelKeys: string[];
}

// Hierarchy path of a row (one extracted key per level), or null when a level label is missing or doesn't extract.
function rowPath(row: NormalizedRow, levels: LevelDef[]): string[] | null {
  const path: string[] = [];
  for (const level of levels) {
    const raw = row.labels[level.label];
    const key = raw === undefined ? null : extractKey(raw, level);
    if (key === null) {
      return null;
    }
    path.push(key);
  }
  return path;
}

function bucketFor(buckets: Map<string, Bucket>, pk: string, opts: CellOptions): Bucket {
  let bucket = buckets.get(pk);
  if (!bucket) {
    bucket = {
      labelSets: [],
      seenLabelSets: new Set(),
      byRef: new Map(),
      sourceLabelSetsByRef: opts.captureSourceLabels ? new Map() : undefined,
      seenSourceLabelSetsByRef: opts.captureSourceLabels ? new Map() : undefined,
      labelValues:
        opts.extraLabelKeys.length > 0
          ? new Map(opts.extraLabelKeys.map((key) => [key, new Set<string>()]))
          : undefined,
    };
    buckets.set(pk, bucket);
  }
  return bucket;
}

// Record all distinct original label sets whose extraction keys collide (duplicates are collapsed).
// Example: even if node-a017 and node-b017 both extract to "017", both can still be searched via drilldown.
function recordLabelSet(bucket: Bucket, row: NormalizedRow, levels: LevelDef[]): void {
  const rep: Record<string, string> = {};
  for (const level of levels) {
    rep[level.label] = row.labels[level.label];
  }
  const repKey = pathKey(levels.map((l) => rep[l.label]));
  if (!bucket.seenLabelSets.has(repKey)) {
    bucket.seenLabelSets.add(repKey);
    bucket.labelSets.push(rep);
  }
}

function recordLabelValues(bucket: Bucket, row: NormalizedRow, extraLabelKeys: string[]): void {
  for (const key of extraLabelKeys) {
    const value = row.labels[key];
    if (value !== undefined && value !== '') {
      bucket.labelValues?.get(key)?.add(value);
    }
  }
}

function recordSourceLabels(bucket: Bucket, row: NormalizedRow): void {
  const sourceKey = JSON.stringify(
    Object.entries(row.labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value])
  );
  const seenSourceLabels = bucket.seenSourceLabelSetsByRef?.get(row.refId) ?? new Set<string>();
  if (seenSourceLabels.has(sourceKey)) {
    return;
  }
  seenSourceLabels.add(sourceKey);
  bucket.seenSourceLabelSetsByRef?.set(row.refId, seenSourceLabels);
  const sourceLabels = bucket.sourceLabelSetsByRef?.get(row.refId) ?? [];
  sourceLabels.push({ ...row.labels });
  bucket.sourceLabelSetsByRef?.set(row.refId, sourceLabels);
}

function addRowToBucket(bucket: Bucket, row: NormalizedRow, opts: CellOptions): void {
  recordLabelSet(bucket, row, opts.levels);
  recordLabelValues(bucket, row, opts.extraLabelKeys);
  if (row.value === null) {
    return;
  }
  if (opts.captureSourceLabels) {
    recordSourceLabels(bucket, row);
  }
  const list = bucket.byRef.get(row.refId) ?? [];
  list.push(row.value);
  bucket.byRef.set(row.refId, list);
}

function collectBuckets(rows: NormalizedRow[], opts: CellOptions): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const path = rowPath(row, opts.levels);
    if (!path) {
      continue;
    }
    addRowToBucket(bucketFor(buckets, pathKey(path), opts), row, opts);
  }
  return buckets;
}

function aggregateValues(bucket: Bucket | undefined, opts: CellOptions): Map<string, number | null> {
  const values = new Map<string, number | null>();
  for (const refId of opts.refIds) {
    const list = bucket?.byRef.get(refId);
    values.set(refId, list && list.length > 0 ? aggregate(list, opts.agg) : null);
  }
  return values;
}

function sortedLabelValues(bucket: Bucket | undefined, extraLabelKeys: string[]): Map<string, string[]> | undefined {
  if (extraLabelKeys.length === 0) {
    return undefined;
  }
  return new Map(
    extraLabelKeys.map((key) => [key, [...(bucket?.labelValues?.get(key) ?? [])].sort((a, b) => a.localeCompare(b))])
  );
}

function buildCell(path: string[], bucket: Bucket | undefined, opts: CellOptions): CellModel {
  const values = aggregateValues(bucket, opts);
  const labelSets = bucket?.labelSets ?? [];
  const labelValues = sortedLabelValues(bucket, opts.extraLabelKeys);
  // labels is the representative original value for backward compatibility (the first set)
  return {
    path,
    labels: labelSets[0] ?? {},
    labelSets,
    ...(labelValues ? { labelValues } : {}),
    ...(opts.captureSourceLabels ? { sourceLabelSetsByRef: bucket?.sourceLabelSetsByRef ?? new Map() } : {}),
    values,
  };
}

export function attachCells(
  root: HierarchyNode,
  rows: NormalizedRow[],
  levels: LevelDef[],
  agg: SpatialAggregation,
  refIds: string[] = collectRefIds(rows),
  captureSourceLabels = false,
  extraLabelKeys: string[] = []
): void {
  const opts: CellOptions = { levels, agg, refIds, captureSourceLabels, extraLabelKeys };
  const buckets = collectBuckets(rows, opts);

  const visit = (node: HierarchyNode) => {
    if (node.children.length === 0 && node.path.length === levels.length) {
      node.cell = buildCell(node.path, buckets.get(pathKey(node.path)), opts);
      return;
    }
    node.children.forEach(visit);
  };
  visit(root);
}
