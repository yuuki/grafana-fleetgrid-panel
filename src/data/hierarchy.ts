import { HierarchyNode, LevelDef, NormalizedRow } from '../types';

export function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

export function extractKey(value: string, level: LevelDef): string | null {
  switch (level.extract) {
    case 'raw':
      return value;
    case 'trailingNumber': {
      const m = /(\d+)$/.exec(value);
      return m ? m[1] : null;
    }
    case 'regex': {
      if (!level.regex) {
        return value;
      }
      let re: RegExp;
      try {
        re = new RegExp(level.regex);
      } catch {
        return null;
      }
      const m = re.exec(value);
      // Per spec, the first capture group is required (a regex without a group treats all rows as a mismatch and surfaces in the warning)
      return m && m[1] !== undefined ? m[1] : null;
    }
  }
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

interface BuildResult {
  root: HierarchyNode;
  warnings: string[];
  leafPaths: Map<string, string[]>;
}

function collectDetectedLabels(rows: NormalizedRow[]): Set<string> {
  const detectedLabels = new Set<string>();
  for (const row of rows) {
    Object.keys(row.labels).forEach((k) => detectedLabels.add(k));
  }
  return detectedLabels;
}

// Per-level application stats: how many rows carry the level's label, and how many of those extract a key.
interface LevelStats {
  labelHit: number[];
  extractHit: number[];
}

// Resolve a row to its full path while updating the per-level stats. Returns null when any level fails.
function resolveRowPath(row: NormalizedRow, levels: LevelDef[], stats: LevelStats): string[] | null {
  const path: string[] = [];
  let ok = true;
  for (let i = 0; i < levels.length; i++) {
    // Collect label-presence/extraction-hit stats for every level, per row.
    // Even if an earlier level fails, keep scanning with continue instead of break, so a label
    // present on every row isn't falsely reported as "was not found in the query results" (path acceptance is tracked separately via ok).
    const raw = row.labels[levels[i].label];
    if (raw === undefined) {
      ok = false;
      continue;
    }
    stats.labelHit[i]++;
    const key = extractKey(raw, levels[i]);
    if (key === null) {
      ok = false;
      continue;
    }
    stats.extractHit[i]++;
    // A row that fails even one level is not treated as a leaf. path is only pushed while every level succeeds.
    if (ok) {
      path.push(key);
    }
  }
  return ok && path.length === levels.length ? path : null;
}

function levelWarnings(levels: LevelDef[], rowCount: number, stats: LevelStats, detectedLabels: Set<string>): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < levels.length; i++) {
    if (rowCount > 0 && stats.labelHit[i] === 0) {
      warnings.push(
        `Label "${levels[i].label}" was not found in the query results (detected labels: ${[...detectedLabels].join(', ')})`
      );
    } else if (stats.labelHit[i] > 0 && stats.extractHit[i] === 0) {
      warnings.push(`The extraction setting for level ${i + 1} did not match any value (label "${levels[i].label}")`);
    }
  }
  return warnings;
}

function buildTree(leafPaths: Map<string, string[]>): HierarchyNode {
  const root: HierarchyNode = { key: '', path: [], children: [] };
  for (const path of leafPaths.values()) {
    let node = root;
    for (const key of path) {
      let child = node.children.find((c) => c.key === key);
      if (!child) {
        child = { key, path: [...node.path, key], children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  return root;
}

function sortLevel(node: HierarchyNode, levels: LevelDef[], depth: number): void {
  const def = levels[depth];
  if (def) {
    if (def.sort === 'natural') {
      node.children.sort((a, b) => naturalCompare(a.key, b.key));
    } else if (def.sort === 'naturalDesc') {
      node.children.sort((a, b) => naturalCompare(b.key, a.key));
    }
  }
  node.children.forEach((c) => sortLevel(c, levels, depth + 1));
}

export function buildHierarchy(rows: NormalizedRow[], levels: LevelDef[]): BuildResult {
  const warnings: string[] = [];
  const detectedLabels = collectDetectedLabels(rows);

  // Collect per-level application stats while resolving rows to paths
  const stats: LevelStats = {
    labelHit: new Array(levels.length).fill(0),
    extractHit: new Array(levels.length).fill(0),
  };
  const leafPaths = new Map<string, string[]>();
  let matched = 0;

  for (const row of rows) {
    const path = resolveRowPath(row, levels, stats);
    if (path) {
      leafPaths.set(pathKey(path), path);
      matched++;
    }
  }

  // Warn even when not a single complete path is formed (matched===0).
  // Prevents silently showing an empty display when there are hits at each level but no row satisfies every level (spec: never silently show empty).
  if (rows.length > 0 && matched < rows.length) {
    warnings.push(`${rows.length - matched}/${rows.length} rows did not match the hierarchy and were excluded`);
  }
  warnings.push(...levelWarnings(levels, rows.length, stats, detectedLabels));

  // Build the tree
  const root = buildTree(leafPaths);

  // Sort per level
  sortLevel(root, levels, 0);

  return { root, warnings, leafPaths };
}
