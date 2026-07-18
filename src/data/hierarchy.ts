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
      // 仕様どおり第1キャプチャグループを必須とする(グループなしregexは全行アンマッチ扱いで警告に乗る)
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

export function buildHierarchy(rows: NormalizedRow[], levels: LevelDef[]): BuildResult {
  const warnings: string[] = [];
  const detectedLabels = new Set<string>();
  for (const row of rows) {
    Object.keys(row.labels).forEach((k) => detectedLabels.add(k));
  }

  // レベルごとの適用統計を取りつつ、行→パスを解決する
  const labelHit = new Array(levels.length).fill(0);
  const extractHit = new Array(levels.length).fill(0);
  const leafPaths = new Map<string, string[]>();
  let matched = 0;

  for (const row of rows) {
    const path: string[] = [];
    let ok = true;
    for (let i = 0; i < levels.length; i++) {
      const raw = row.labels[levels[i].label];
      if (raw === undefined) {
        ok = false;
        break;
      }
      labelHit[i]++;
      const key = extractKey(raw, levels[i]);
      if (key === null) {
        ok = false;
        break;
      }
      extractHit[i]++;
      path.push(key);
    }
    if (ok && path.length === levels.length) {
      leafPaths.set(pathKey(path), path);
      matched++;
    }
  }

  if (rows.length > 0 && matched > 0 && matched < rows.length) {
    warnings.push(`${rows.length - matched}/${rows.length} 行が階層にマッチせず除外されました`);
  }

  for (let i = 0; i < levels.length; i++) {
    if (rows.length > 0 && labelHit[i] === 0) {
      warnings.push(
        `ラベル "${levels[i].label}" がクエリ結果にありません(検出されたラベル: ${[...detectedLabels].join(', ')})`
      );
    } else if (labelHit[i] > 0 && extractHit[i] === 0) {
      warnings.push(`レベル ${i + 1} の抽出設定がどの値にもマッチしません(ラベル "${levels[i].label}")`);
    }
  }

  // ツリー構築
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

  // レベルごとのソート
  const sortLevel = (node: HierarchyNode, depth: number) => {
    const def = levels[depth];
    if (def) {
      if (def.sort === 'natural') {
        node.children.sort((a, b) => naturalCompare(a.key, b.key));
      } else if (def.sort === 'naturalDesc') {
        node.children.sort((a, b) => naturalCompare(b.key, a.key));
      }
    }
    node.children.forEach((c) => sortLevel(c, depth + 1));
  };
  sortLevel(root, 0);

  return { root, warnings, leafPaths };
}
