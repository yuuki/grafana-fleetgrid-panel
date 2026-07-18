# ClusterView パネルプラグイン実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仕様書 `docs/specs/2026-07-18-clusterview-panel-design.md` に定めたClusterViewパネルプラグイン(階層グリッド+標準カラースキーム+複数メトリクス+ドリルダウン)を実装する。

**Architecture:** データ変換(normalize→hierarchy→cells→display)とレイアウト計算を純関数として実装し、単一Canvasに描画する。ツールチップ、ポップオーバー、セレクタ、凡例はReact DOMオーバーレイ。色と単位はGrafana標準のdisplay processorに委譲する。

**Tech Stack:** TypeScript, React 18, @grafana/create-plugin(webpack/SWC), @grafana/data / ui / runtime, Jest + React Testing Library, Playwright (@grafana/plugin-e2e)

## Global Constraints

- plugin id: `yuuk1-clusterview-panel`、表示名: `ClusterView`、type: `panel`
- `grafanaDependency: ">=11.6.0"`
- データソースは Prometheus / VictoriaMetrics のみ対象(実装はデータソース非依存のフレーム処理で書く)
- 色、単位、桁数、min/max、Data LinksはGrafana標準field config委譲。独自の色条件DSLを実装しない
- コード、テスト、コミットメッセージに実環境固有の名称を書かない。フィクスチャは `zone-a`, `node-a001` などの一般名を使う
- 各タスクの最後に `npm run typecheck && npm run lint && npm run test:ci` を実行して全て成功させてからコミットする
- コミットメッセージは `feat:` / `test:` / `docs:` / `chore:` プレフィックス
- YAGNI: 仕様書「スコープ外」節の機能を実装しない

---

### Task 1: scaffold生成とプラグインメタ設定

**Files:**
- Create: `@grafana/create-plugin` が生成する一式(`src/`, `.config/`, `package.json`, `docker-compose.yaml` など)をリポジトリルートに配置
- Modify: `src/plugin.json`

**Interfaces:**
- Produces: 以後の全タスクが使うビルド/テスト基盤。`npm run dev|build|test:ci|typecheck|lint|e2e|server`

- [ ] **Step 1: scaffoldを生成**

リポジトリルートで実行。create-pluginはサブディレクトリを作るため、生成後に中身をルートへ移動する。

```bash
cd /Users/y-tsubouchi/src/github.com/yuuki/grafana-clusterview-panel
npx @grafana/create-plugin@latest --pluginName=clusterview --orgName=yuuk1 --pluginType=panel --no-backend
```

注: フラグ名はバージョンにより異なることがある。失敗したら `npx @grafana/create-plugin@latest --help` で非対話フラグを確認して読み替える。生成先ディレクトリ名は `yuuk1-clusterview-panel/` になる。

```bash
rsync -a yuuk1-clusterview-panel/ ./ --exclude LICENSE   # 既存LICENSEを保持
rm -rf yuuk1-clusterview-panel
npm install
```

- [ ] **Step 2: plugin.jsonを編集**

`src/plugin.json` の該当キーを次の値にする(他は生成値のまま):

```json
{
  "type": "panel",
  "name": "ClusterView",
  "id": "yuuk1-clusterview-panel",
  "dependencies": {
    "grafanaDependency": ">=11.6.0",
    "plugins": []
  }
}
```

- [ ] **Step 3: ビルドとテストが通ることを確認**

```bash
npm run typecheck && npm run lint && npm run test:ci && npm run build
```

Expected: すべて成功(scaffold付属のサンプルテストが通る)。
scaffoldのscript名が異なる場合(`test:ci` がない等)は `package.json` の scripts を確認して読み替え、以後のタスクでも同じ名前を使う。

- [ ] **Step 4: コミット**

```bash
git add -A
git commit -m "chore: scaffold panel plugin with @grafana/create-plugin"
```

---

### Task 2: 型定義

**Files:**
- Create: `src/types.ts`(scaffold生成物があれば置き換え)

**Interfaces:**
- Produces: 以後の全タスクが参照する型。
  - `LevelDef { label: string; extract: 'raw'|'trailingNumber'|'regex'; regex?: string; sort: 'natural'|'naturalDesc'|'none'; layout: 'vertical'|'horizontal'|'flow'|'grid'; gridColumns?: number; showBorder: boolean; showLabel: boolean }`
  - `ClusterviewOptions { levels: LevelDef[]; displayMode: 'single'|'split'; defaultMetric?: string; showValues: boolean; missingColor: string; spatialAggregation: 'max'|'mean'|'min'|'sum'; reduceCalc: string }`
  - `NormalizedRow { labels: Record<string,string>; value: number|null; refId: string }`
  - `CellModel { path: string[]; labels: Record<string,string>; values: Map<string, number|null> }`(labelsは階層に使ったラベルキーの代表原値。ドリルダウンの系列特定に使う)
  - `HierarchyNode { key: string; path: string[]; children: HierarchyNode[]; cell?: CellModel }`

- [ ] **Step 1: src/types.ts を作成**

```ts
export type ExtractPreset = 'raw' | 'trailingNumber' | 'regex';
export type SortOrder = 'natural' | 'naturalDesc' | 'none';
export type LevelLayout = 'vertical' | 'horizontal' | 'flow' | 'grid';
export type SpatialAggregation = 'max' | 'mean' | 'min' | 'sum';
export type DisplayMode = 'single' | 'split';

export interface LevelDef {
  label: string;
  extract: ExtractPreset;
  regex?: string;
  sort: SortOrder;
  layout: LevelLayout;
  gridColumns?: number;
  showBorder: boolean;
  showLabel: boolean;
}

export interface ClusterviewOptions {
  levels: LevelDef[];
  displayMode: DisplayMode;
  defaultMetric?: string;
  showValues: boolean;
  missingColor: string;
  spatialAggregation: SpatialAggregation;
  /** ReducerID (e.g. 'lastNotNull') — 時間方向reduce */
  reduceCalc: string;
}

export const DEFAULT_LEVEL: LevelDef = {
  label: '',
  extract: 'raw',
  sort: 'natural',
  layout: 'flow',
  showBorder: false,
  showLabel: true,
};

export interface NormalizedRow {
  labels: Record<string, string>;
  value: number | null;
  refId: string;
}

export interface CellModel {
  path: string[];
  /** 階層に使ったラベルキーの代表原値(ドリルダウンの系列特定に使う) */
  labels: Record<string, string>;
  values: Map<string, number | null>;
}

export interface HierarchyNode {
  key: string;
  path: string[];
  children: HierarchyNode[];
  cell?: CellModel;
}
```

- [ ] **Step 2: typecheckとコミット**

```bash
npm run typecheck && npm run lint
git add src/types.ts
git commit -m "feat: add option and cell model types"
```

---

### Task 3: normalize(フレーム正規化)

**Files:**
- Create: `src/data/normalize.ts`
- Test: `src/data/normalize.test.ts`

**Interfaces:**
- Consumes: `NormalizedRow`(Task 2)
- Produces: `normalizeFrames(frames: DataFrame[], reduceCalc: string): NormalizedRow[]`
  - time series形式: 数値フィールドごとに1行。`field.labels` をlabelsに、値は `reduceCalc`(ReducerID)で時間方向に畳む
  - table形式(時間フィールドなし+文字列フィールドあり): データ行ごとに1行。文字列列をlabelsに、最初の数値列を値に
  - refIdは `frame.refId ?? 'A'`

- [ ] **Step 1: 失敗するテストを書く**

`src/data/normalize.test.ts`:

```ts
import { toDataFrame, FieldType } from '@grafana/data';
import { normalizeFrames } from './normalize';

describe('normalizeFrames', () => {
  it('extracts labels and last non-null value from time series frames', () => {
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000, 2000, 3000] },
        {
          name: 'Value',
          type: FieldType.number,
          values: [10, 20, null],
          labels: { zone: 'zone-a', 'host.name': 'node-a001', gpu: '0' },
        },
      ],
    });
    const rows = normalizeFrames([frame], 'lastNotNull');
    expect(rows).toEqual([
      {
        labels: { zone: 'zone-a', 'host.name': 'node-a001', gpu: '0' },
        value: 20,
        refId: 'A',
      },
    ]);
  });

  it('reads label columns and value column from table frames', () => {
    const frame = toDataFrame({
      refId: 'B',
      fields: [
        { name: 'zone', type: FieldType.string, values: ['zone-a', 'zone-b'] },
        { name: 'gpu', type: FieldType.string, values: ['0', '1'] },
        { name: 'Value', type: FieldType.number, values: [61, 55] },
      ],
    });
    const rows = normalizeFrames([frame], 'lastNotNull');
    expect(rows).toEqual([
      { labels: { zone: 'zone-a', gpu: '0' }, value: 61, refId: 'B' },
      { labels: { zone: 'zone-b', gpu: '1' }, value: 55, refId: 'B' },
    ]);
  });

  it('returns null value when a series is all null', () => {
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000] },
        { name: 'Value', type: FieldType.number, values: [null], labels: { zone: 'zone-a' } },
      ],
    });
    expect(normalizeFrames([frame], 'lastNotNull')[0].value).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- normalize
```

Expected: FAIL(`./normalize` が存在しない)

- [ ] **Step 3: 実装**

`src/data/normalize.ts`:

```ts
import { DataFrame, Field, FieldType, reduceField } from '@grafana/data';
import { NormalizedRow } from '../types';

export function normalizeFrames(frames: DataFrame[], reduceCalc: string): NormalizedRow[] {
  const rows: NormalizedRow[] = [];
  for (const frame of frames) {
    const refId = frame.refId ?? 'A';
    const timeField = frame.fields.find((f) => f.type === FieldType.time);
    const stringFields = frame.fields.filter((f) => f.type === FieldType.string);
    const numberFields = frame.fields.filter((f) => f.type === FieldType.number);

    if (!timeField && stringFields.length > 0) {
      // table形式: 行ごとに1レコード
      const valueField = numberFields[0];
      if (!valueField) {
        continue;
      }
      for (let i = 0; i < frame.length; i++) {
        const labels: Record<string, string> = {};
        for (const f of stringFields) {
          labels[f.name] = String(f.values[i]);
        }
        const raw = valueField.values[i];
        rows.push({ labels, value: raw == null ? null : Number(raw), refId });
      }
      continue;
    }

    // time series形式: 数値フィールドごとに1レコード
    for (const field of numberFields) {
      rows.push({
        labels: { ...(field.labels ?? {}) },
        value: reduceToValue(field, reduceCalc),
        refId,
      });
    }
  }
  return rows;
}

function reduceToValue(field: Field, reduceCalc: string): number | null {
  const stats = reduceField({ field, reducers: [reduceCalc] });
  const v = stats[reduceCalc];
  return v == null || Number.isNaN(v) ? null : v;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- normalize
```

Expected: PASS(3件)

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/data/normalize.ts src/data/normalize.test.ts
git commit -m "feat: normalize time series and table frames into label rows"
```

---

### Task 4: hierarchy(階層キー抽出、natural sort、ツリー構築)

**Files:**
- Create: `src/data/hierarchy.ts`
- Test: `src/data/hierarchy.test.ts`

**Interfaces:**
- Consumes: `NormalizedRow`, `LevelDef`, `HierarchyNode`(Task 2)
- Produces:
  - `extractKey(value: string, level: LevelDef): string | null` — 抽出プリセット適用。マッチしなければnull
  - `naturalCompare(a: string, b: string): number`
  - `buildHierarchy(rows: NormalizedRow[], levels: LevelDef[]): { root: HierarchyNode; warnings: string[]; leafPaths: Map<string, string[]> }`
    - rootは仮想ルート(`key: ''`)。葉のcellはまだ持たない(Task 5で付与)
    - warnings: ラベル不在(全行にラベルキーがない)、抽出全アンマッチを文言つきで返す
    - leafPaths: `pathKey(path)` → path。Task 5がセル生成に使う
  - `pathKey(path: string[]): string` — パスの安定文字列化(区切りは `' '`)

- [ ] **Step 1: 失敗するテストを書く**

`src/data/hierarchy.test.ts`:

```ts
import { DEFAULT_LEVEL, LevelDef, NormalizedRow } from '../types';
import { buildHierarchy, extractKey, naturalCompare, pathKey } from './hierarchy';

const level = (over: Partial<LevelDef>): LevelDef => ({ ...DEFAULT_LEVEL, ...over });

describe('extractKey', () => {
  it('returns raw value for raw preset', () => {
    expect(extractKey('zone-a', level({ label: 'zone', extract: 'raw' }))).toBe('zone-a');
  });
  it('extracts trailing number', () => {
    expect(extractKey('node-a004', level({ label: 'h', extract: 'trailingNumber' }))).toBe('004');
    expect(extractKey('node-x', level({ label: 'h', extract: 'trailingNumber' }))).toBeNull();
  });
  it('extracts first capture group of custom regex', () => {
    expect(extractKey('node-a004', level({ label: 'h', extract: 'regex', regex: 'node-.+?(\\d\\d\\d)' }))).toBe('004');
    expect(extractKey('other', level({ label: 'h', extract: 'regex', regex: 'node-(\\d+)' }))).toBeNull();
  });
});

describe('naturalCompare', () => {
  it('compares embedded numbers numerically', () => {
    expect(naturalCompare('002', '010')).toBeLessThan(0);
    expect(naturalCompare('node-a2', 'node-a10')).toBeLessThan(0);
  });
});

describe('buildHierarchy', () => {
  const rows: NormalizedRow[] = [
    { labels: { zone: 'zone-b', gpu: '1' }, value: 1, refId: 'A' },
    { labels: { zone: 'zone-a', gpu: '10' }, value: 2, refId: 'A' },
    { labels: { zone: 'zone-a', gpu: '2' }, value: 3, refId: 'A' },
  ];
  const levels = [
    level({ label: 'zone', layout: 'vertical' }),
    level({ label: 'gpu', layout: 'grid', gridColumns: 2 }),
  ];

  it('builds a sorted tree and leaf paths', () => {
    const { root, warnings, leafPaths } = buildHierarchy(rows, levels);
    expect(warnings).toEqual([]);
    expect(root.children.map((c) => c.key)).toEqual(['zone-a', 'zone-b']);
    expect(root.children[0].children.map((c) => c.key)).toEqual(['2', '10']); // natural sort
    expect([...leafPaths.values()]).toContainEqual(['zone-a', '2']);
  });

  it('sorts descending when configured', () => {
    const desc = [level({ label: 'zone', sort: 'naturalDesc' }), level({ label: 'gpu' })];
    const { root } = buildHierarchy(rows, desc);
    expect(root.children.map((c) => c.key)).toEqual(['zone-b', 'zone-a']);
  });

  it('warns when a label is missing from all rows', () => {
    const { warnings } = buildHierarchy(rows, [level({ label: 'rack' })]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('rack');
    expect(warnings[0]).toContain('zone'); // 検出済みラベルの提示
  });

  it('warns when regex matches no rows', () => {
    const { warnings } = buildHierarchy(rows, [
      level({ label: 'zone', extract: 'regex', regex: 'nomatch-(\\d+)' }),
    ]);
    expect(warnings.length).toBe(1);
  });

  it('round-trips pathKey', () => {
    expect(pathKey(['a', 'b'])).not.toBe(pathKey(['a', 'c']));
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- hierarchy
```

Expected: FAIL(`./hierarchy` が存在しない)

- [ ] **Step 3: 実装**

`src/data/hierarchy.ts`:

```ts
import { HierarchyNode, LevelDef, NormalizedRow } from '../types';

const SEP = ' ';

export function pathKey(path: string[]): string {
  return path.join(SEP);
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
      return m ? (m[1] ?? m[0]) : null;
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
    }
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
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- hierarchy
```

Expected: PASS(8件)

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/data/hierarchy.ts src/data/hierarchy.test.ts
git commit -m "feat: build sorted hierarchy tree from label rows"
```

---

### Task 5: cells(union、欠損、空間集約)

**Files:**
- Create: `src/data/values.ts`
- Test: `src/data/values.test.ts`

**Interfaces:**
- Consumes: `buildHierarchy` の結果(Task 4)、`NormalizedRow`、`SpatialAggregation`
- Produces:
  - `attachCells(root: HierarchyNode, rows: NormalizedRow[], levels: LevelDef[], agg: SpatialAggregation): void` — 各葉に `cell: CellModel` を付与する(in-place)。`cell.values` は出現した全refIdをキーに持ち、系列がないrefIdは `null`。`cell.labels` には階層に使ったラベルキーの代表原値(最初に該当した行のもの)を入れる
  - `collectRefIds(rows: NormalizedRow[]): string[]` — 出現順のrefId一覧

- [ ] **Step 1: 失敗するテストを書く**

`src/data/values.test.ts`:

```ts
import { DEFAULT_LEVEL, LevelDef, NormalizedRow } from '../types';
import { buildHierarchy } from './hierarchy';
import { attachCells, collectRefIds } from './values';

const levels: LevelDef[] = [
  { ...DEFAULT_LEVEL, label: 'zone' },
  { ...DEFAULT_LEVEL, label: 'gpu' },
];

describe('attachCells', () => {
  it('unions nodes across queries and marks missing values as null', () => {
    const rows: NormalizedRow[] = [
      { labels: { zone: 'zone-a', gpu: '0' }, value: 503, refId: 'A' },
      { labels: { zone: 'zone-a', gpu: '0' }, value: 61, refId: 'B' },
      { labels: { zone: 'zone-a', gpu: '1' }, value: 28, refId: 'B' }, // Aには存在しない
    ];
    const { root } = buildHierarchy(rows, levels);
    attachCells(root, rows, levels, 'max');
    const zoneA = root.children[0];
    const cell0 = zoneA.children.find((c) => c.key === '0')!.cell!;
    const cell1 = zoneA.children.find((c) => c.key === '1')!.cell!;
    expect(cell0.values.get('A')).toBe(503);
    expect(cell0.values.get('B')).toBe(61);
    expect(cell1.values.get('A')).toBeNull(); // union由来の欠損
    expect(cell1.values.get('B')).toBe(28);
    expect(cell0.labels).toEqual({ zone: 'zone-a', gpu: '0' }); // 代表原値
  });

  it('aggregates multiple series falling into one cell', () => {
    const oneLevel: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'zone' }];
    const rows: NormalizedRow[] = [
      { labels: { zone: 'zone-a', gpu: '0' }, value: 10, refId: 'A' },
      { labels: { zone: 'zone-a', gpu: '1' }, value: 30, refId: 'A' },
    ];
    const { root } = buildHierarchy(rows, oneLevel);
    attachCells(root, rows, oneLevel, 'max');
    expect(root.children[0].cell!.values.get('A')).toBe(30);
    attachCells(root, rows, oneLevel, 'mean');
    expect(root.children[0].cell!.values.get('A')).toBe(20);
    attachCells(root, rows, oneLevel, 'sum');
    expect(root.children[0].cell!.values.get('A')).toBe(40);
    attachCells(root, rows, oneLevel, 'min');
    expect(root.children[0].cell!.values.get('A')).toBe(10);
  });

  it('collects refIds in appearance order', () => {
    const rows: NormalizedRow[] = [
      { labels: {}, value: 1, refId: 'B' },
      { labels: {}, value: 2, refId: 'A' },
      { labels: {}, value: 3, refId: 'B' },
    ];
    expect(collectRefIds(rows)).toEqual(['B', 'A']);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- values
```

Expected: FAIL(`./values` が存在しない)

- [ ] **Step 3: 実装**

`src/data/values.ts`:

```ts
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
  agg: SpatialAggregation
): void {
  const refIds = collectRefIds(rows);

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
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- values
```

Expected: PASS(3件)

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/data/values.ts src/data/values.test.ts
git commit -m "feat: attach per-query cell values with union and spatial aggregation"
```

---

### Task 6: display(refId単位スケール、display processor、数値テキスト選択)

**Files:**
- Create: `src/data/display.ts`
- Test: `src/data/display.test.ts`

**Interfaces:**
- Consumes: `PanelData`のフレーム群、`@grafana/data` の `getDisplayProcessor`
- Produces:
  - `MetricInfo { refId: string; name: string; processor: DisplayProcessor; field: Field; frame: DataFrame }`
  - `buildMetricInfos(frames: DataFrame[], theme: GrafanaTheme2, timeZone: string): MetricInfo[]`
    - refIdごとに先頭フレームの数値フィールドから代表configを取り、min/max未設定ならそのrefIdの全数値の範囲で補完してprocessorを構築
    - nameはクエリ表示名(`getFieldDisplayName`のフレーム名部分)。フレームnameがなければrefId
  - `chooseCellText(display: DisplayValue, cellW: number, cellH: number, measure: (text: string, fontPx: number) => number): { text: string; fontPx: number } | null`
    - フォント= `clamp(cellH * 0.38, 9, 15)`。`suffix付き → 数値のみ → null` の順で判定。条件は `幅+4 <= cellW`

- [ ] **Step 1: 失敗するテストを書く**

`src/data/display.test.ts`:

```ts
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos, chooseCellText } from './display';

const theme = createTheme();

const frame = (refId: string, name: string, values: number[], config = {}) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: values.map((_, i) => i * 1000) },
      { name: 'Value', type: FieldType.number, values, config, labels: { zone: 'zone-a' } },
    ],
  });

describe('buildMetricInfos', () => {
  it('builds one info per refId with auto min/max from that query only', () => {
    const infos = buildMetricInfos(
      [frame('A', 'power', [600, 1000]), frame('B', 'temp', [30, 90])],
      theme,
      'browser'
    );
    expect(infos.map((i) => i.refId)).toEqual(['A', 'B']);
    // Aのmin/maxはAのデータ範囲(600-1000)になる: 800は中間の色、Bの範囲とは独立
    const a = infos[0].processor(800);
    const b = infos[1].processor(60);
    expect(a.color).toBeDefined();
    expect(b.color).toBeDefined();
    expect(infos[0].field.config.min).toBe(600);
    expect(infos[0].field.config.max).toBe(1000);
    expect(infos[1].field.config.min).toBe(30);
    expect(infos[1].field.config.max).toBe(90);
  });

  it('respects explicit min/max from field config', () => {
    const infos = buildMetricInfos([frame('A', 'power', [600, 1000], { min: 0, max: 2000 })], theme, 'browser');
    expect(infos[0].field.config.min).toBe(0);
    expect(infos[0].field.config.max).toBe(2000);
  });
});

describe('chooseCellText', () => {
  // 幅 = 文字数 × fontPx × 0.6 の擬似メジャラ
  const measure = (text: string, fontPx: number) => text.length * fontPx * 0.6;
  const display = { text: '503', suffix: ' W', numeric: 503 } as any;

  it('renders text with suffix when it fits', () => {
    const r = chooseCellText(display, 60, 20, measure);
    expect(r).toEqual({ text: '503 W', fontPx: 20 * 0.38 < 9 ? 9 : Math.min(15, 20 * 0.38) });
  });

  it('falls back to number only when suffix does not fit', () => {
    const r = chooseCellText(display, 24, 20, measure);
    expect(r?.text).toBe('503');
  });

  it('returns null when nothing fits', () => {
    expect(chooseCellText(display, 8, 20, measure)).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- display
```

Expected: FAIL(`./display` が存在しない)

- [ ] **Step 3: 実装**

`src/data/display.ts`:

```ts
import {
  DataFrame,
  DisplayProcessor,
  DisplayValue,
  Field,
  FieldType,
  GrafanaTheme2,
  getDisplayProcessor,
} from '@grafana/data';

export interface MetricInfo {
  refId: string;
  name: string;
  processor: DisplayProcessor;
  field: Field;
  frame: DataFrame;
}

export function buildMetricInfos(frames: DataFrame[], theme: GrafanaTheme2, timeZone: string): MetricInfo[] {
  const byRef = new Map<string, DataFrame[]>();
  for (const f of frames) {
    const refId = f.refId ?? 'A';
    byRef.set(refId, [...(byRef.get(refId) ?? []), f]);
  }

  const infos: MetricInfo[] = [];
  for (const [refId, group] of byRef) {
    const firstNumeric = group
      .flatMap((f) => f.fields.map((field) => ({ field, frame: f })))
      .find(({ field }) => field.type === FieldType.number);
    if (!firstNumeric) {
      continue;
    }

    // refId内の全数値からmin/maxを補完(明示設定があれば優先)
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const f of group) {
      for (const field of f.fields) {
        if (field.type !== FieldType.number) {
          continue;
        }
        for (const v of field.values) {
          if (v == null || Number.isNaN(v)) {
            continue;
          }
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
    }
    if (!Number.isFinite(min)) {
      min = 0;
      max = 1;
    }
    if (min === max) {
      max = min + 1;
    }

    const config = { ...firstNumeric.field.config };
    config.min = config.min ?? min;
    config.max = config.max ?? max;
    const field: Field = { ...firstNumeric.field, config };
    const processor = getDisplayProcessor({ field, theme, timeZone });

    infos.push({
      refId,
      name: group[0].name ?? refId,
      processor,
      field,
      frame: firstNumeric.frame,
    });
  }
  return infos;
}

const FONT_MIN = 9;
const FONT_MAX = 15;
const TEXT_PAD = 4;

export function chooseCellText(
  display: DisplayValue,
  cellW: number,
  cellH: number,
  measure: (text: string, fontPx: number) => number
): { text: string; fontPx: number } | null {
  const fontPx = Math.min(FONT_MAX, Math.max(FONT_MIN, cellH * 0.38));
  if (cellH < FONT_MIN + 2) {
    return null;
  }
  const withSuffix = `${display.text}${display.suffix ?? ''}`;
  if (measure(withSuffix, fontPx) + TEXT_PAD <= cellW) {
    return { text: withSuffix, fontPx };
  }
  if (measure(display.text, fontPx) + TEXT_PAD <= cellW) {
    return { text: display.text, fontPx };
  }
  return null;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- display
```

Expected: PASS(5件)

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/data/display.ts src/data/display.test.ts
git commit -m "feat: per-query display processors and cell text fitting"
```

---

### Task 7: layout(レイアウトエンジン)

**Files:**
- Create: `src/layout/layout.ts`
- Test: `src/layout/layout.test.ts`

**Interfaces:**
- Consumes: `HierarchyNode`, `LevelDef`(Task 2)
- Produces:
  - `LayoutCell { x: number; y: number; w: number; h: number; cell: CellModel }`
  - `LayoutLabel { text: string; x: number; y: number; w: number; h: number; depth: number }`
  - `LayoutBorder { x: number; y: number; w: number; h: number; depth: number }`
  - `LayoutResult { cells: LayoutCell[]; labels: LayoutLabel[]; borders: LayoutBorder[]; cellSize: number; contentWidth: number; contentHeight: number; scrollable: boolean }`
  - `computeLayout(root: HierarchyNode, levels: LevelDef[], width: number, height: number): LayoutResult`
  - 定数: `S_MIN=6, S_MAX=40, CELL_GAP=1, GROUP_GAP=4, LABEL_H=16, BORDER_PAD=2`(export、renderとテストが参照)
- 規則: `levels[i]` は「path長 i+1 のノード」のキー抽出と装飾(showBorder/showLabel)を定義し、`levels[i].layout` はそのノード群の親内での並べ方を定義する。葉レベルのshowLabelは無視する(セル内テキストはTask 6の数値表示が担う)

- [ ] **Step 1: 失敗するテストを書く**

`src/layout/layout.test.ts`:

```ts
import { DEFAULT_LEVEL, LevelDef, HierarchyNode, CellModel } from '../types';
import { computeLayout, S_MIN, S_MAX, CELL_GAP, LABEL_H } from './layout';

const cell = (path: string[]): CellModel => ({ path, labels: {}, values: new Map([['A', 1]]) });

const leaf = (key: string, path: string[]): HierarchyNode => ({ key, path, children: [], cell: cell(path) });

function tree(zones: string[][], gpuKeys: string[]): HierarchyNode {
  // zones: [['zone-a'], ...] 各zoneにgpuKeysの葉をぶら下げる
  return {
    key: '',
    path: [],
    children: zones.map(([z]) => ({
      key: z,
      path: [z],
      children: gpuKeys.map((g) => leaf(g, [z, g])),
    })),
  };
}

describe('computeLayout', () => {
  const levels: LevelDef[] = [
    { ...DEFAULT_LEVEL, label: 'zone', layout: 'vertical', showLabel: true },
    { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 2, showLabel: false },
  ];

  it('reaches S_MAX when space is ample', () => {
    const r = computeLayout(tree([['zone-a']], ['0', '1', '2', '3']), levels, 800, 800);
    expect(r.cellSize).toBe(S_MAX);
    expect(r.scrollable).toBe(false);
    expect(r.cells).toHaveLength(4);
    // grid 2列: (0,0),(s+gap,0),(0,s+gap),(s+gap,s+gap) +ラベル行オフセット
    const s = r.cellSize;
    const xs = r.cells.map((c) => c.x).sort((a, b) => a - b);
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(s + CELL_GAP);
    expect(r.cells[0].y).toBe(LABEL_H); // zoneラベルの下から始まる
  });

  it('emits group labels for levels with showLabel', () => {
    const r = computeLayout(tree([['zone-a'], ['zone-b']], ['0']), levels, 800, 800);
    expect(r.labels.map((l) => l.text)).toEqual(['zone-a', 'zone-b']);
  });

  it('finds intermediate cell size by binary search', () => {
    // 1 zone × 100 GPU、10列grid。幅800なら 800/10−gap ≒ 79 → S_MAXでは幅超過しない
    // 高さを絞って中間サイズを強制: 10行 × (s+1) + LABEL_H <= 200
    const wide: LevelDef[] = [
      { ...DEFAULT_LEVEL, label: 'zone', layout: 'vertical', showLabel: true },
      { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 10, showLabel: false },
    ];
    const keys = Array.from({ length: 100 }, (_, i) => String(i));
    const r = computeLayout(tree([['zone-a']], keys), wide, 800, 200);
    expect(r.cellSize).toBeGreaterThan(S_MIN);
    expect(r.cellSize).toBeLessThan(S_MAX);
    expect(r.contentHeight).toBeLessThanOrEqual(200);
    expect(r.scrollable).toBe(false);
  });

  it('clamps to S_MIN and marks scrollable when even minimum does not fit', () => {
    const keys = Array.from({ length: 100 }, (_, i) => String(i));
    const wide: LevelDef[] = [
      { ...DEFAULT_LEVEL, label: 'zone', layout: 'vertical' },
      { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 2 },
    ];
    const r = computeLayout(tree([['zone-a']], keys), wide, 200, 100);
    expect(r.cellSize).toBe(S_MIN);
    expect(r.scrollable).toBe(true);
    expect(r.contentHeight).toBeGreaterThan(100);
  });

  it('wraps children in flow layout', () => {
    const flow: LevelDef[] = [
      { ...DEFAULT_LEVEL, label: 'zone', layout: 'flow', showLabel: false },
      { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 1 },
    ];
    // 4 zone、各1葉。幅を2グループ分に絞ると2行になる
    const zones = [['z1'], ['z2'], ['z3'], ['z4']];
    const r = computeLayout(tree(zones, ['0']), flow, 2 * (S_MAX + 4) + 2, 800);
    const ys = new Set(r.cells.map((c) => c.y));
    expect(ys.size).toBe(2);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- layout
```

Expected: FAIL(`./layout` が存在しない)

- [ ] **Step 3: 実装**

`src/layout/layout.ts`:

```ts
import { CellModel, HierarchyNode, LevelDef } from '../types';

export const S_MIN = 6;
export const S_MAX = 40;
export const CELL_GAP = 1;
export const GROUP_GAP = 4;
export const LABEL_H = 16;
export const BORDER_PAD = 2;

export interface LayoutCell {
  x: number;
  y: number;
  w: number;
  h: number;
  cell: CellModel;
}

export interface LayoutLabel {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface LayoutBorder {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface LayoutResult {
  cells: LayoutCell[];
  labels: LayoutLabel[];
  borders: LayoutBorder[];
  cellSize: number;
  contentWidth: number;
  contentHeight: number;
  scrollable: boolean;
}

interface Out {
  cells: LayoutCell[];
  labels: LayoutLabel[];
  borders: LayoutBorder[];
}

interface Size {
  w: number;
  h: number;
}

export function computeLayout(
  root: HierarchyNode,
  levels: LevelDef[],
  width: number,
  height: number
): LayoutResult {
  const measure = (s: number): Size => layoutNode(root, levels, s, width, 0, 0, null);
  const fits = (s: number) => {
    const m = measure(s);
    return m.w <= width && m.h <= height;
  };

  let s: number;
  if (!fits(S_MIN)) {
    s = S_MIN;
  } else if (fits(S_MAX)) {
    s = S_MAX;
  } else {
    let lo = S_MIN;
    let hi = S_MAX;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    s = Math.floor(lo * 2) / 2; // 0.5px単位に切り下げ
  }

  const out: Out = { cells: [], labels: [], borders: [] };
  const size = layoutNode(root, levels, s, width, 0, 0, out);
  return {
    ...out,
    cellSize: s,
    contentWidth: size.w,
    contentHeight: size.h,
    scrollable: size.h > height,
  };
}

function layoutNode(
  node: HierarchyNode,
  levels: LevelDef[],
  s: number,
  availW: number,
  x: number,
  y: number,
  out: Out | null
): Size {
  const depth = node.path.length;
  if (depth === levels.length) {
    if (out && node.cell) {
      out.cells.push({ x, y, w: s, h: s, cell: node.cell });
    }
    return { w: s, h: s };
  }

  const childDef = levels[depth];
  const childIsLeaf = depth === levels.length - 1;
  const gap = childIsLeaf ? CELL_GAP : GROUP_GAP;
  const pad = childDef.showBorder ? BORDER_PAD : 0;
  const labelH = childDef.showLabel && !childIsLeaf ? LABEL_H : 0;

  // 子(装飾込み)の配置。emit=nullなら計測のみ
  const childBox = (child: HierarchyNode, innerAvailW: number, cx: number, cy: number, emit: Out | null): Size => {
    const inner = layoutNode(child, levels, s, innerAvailW - pad * 2, cx + pad, cy + pad + labelH, emit);
    const w = inner.w + pad * 2;
    const h = inner.h + pad * 2 + labelH;
    if (emit) {
      if (labelH) {
        emit.labels.push({ text: child.key, x: cx + pad, y: cy + pad, w: inner.w, h: LABEL_H, depth: depth + 1 });
      }
      if (childDef.showBorder) {
        emit.borders.push({ x: cx, y: cy, w, h, depth: depth + 1 });
      }
    }
    return { w, h };
  };

  switch (childDef.layout) {
    case 'vertical': {
      let w = 0;
      let h = 0;
      for (const c of node.children) {
        const size = childBox(c, availW, x, y + h, out);
        w = Math.max(w, size.w);
        h += size.h + gap;
      }
      return { w, h: Math.max(0, h - gap) };
    }
    case 'horizontal': {
      let w = 0;
      let h = 0;
      for (const c of node.children) {
        const size = childBox(c, Math.max(0, availW - w), x + w, y, out);
        h = Math.max(h, size.h);
        w += size.w + gap;
      }
      return { w: Math.max(0, w - gap), h };
    }
    case 'flow': {
      let cx = 0;
      let cy = 0;
      let rowH = 0;
      let maxW = 0;
      for (const c of node.children) {
        const m = childBox(c, availW, 0, 0, null);
        if (cx > 0 && cx + m.w > availW) {
          cx = 0;
          cy += rowH + gap;
          rowH = 0;
        }
        childBox(c, availW, x + cx, y + cy, out);
        cx += m.w + gap;
        rowH = Math.max(rowH, m.h);
        maxW = Math.max(maxW, cx - gap);
      }
      return { w: maxW, h: cy + rowH };
    }
    case 'grid': {
      const cols = Math.max(1, childDef.gridColumns ?? 1);
      let cellW = 0;
      let cellH = 0;
      for (const c of node.children) {
        const m = childBox(c, availW, 0, 0, null);
        cellW = Math.max(cellW, m.w);
        cellH = Math.max(cellH, m.h);
      }
      node.children.forEach((c, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        childBox(c, availW, x + col * (cellW + gap), y + row * (cellH + gap), out);
      });
      const rows = Math.ceil(node.children.length / cols);
      return {
        w: node.children.length > 0 ? Math.min(cols, node.children.length) * (cellW + gap) - gap : 0,
        h: rows > 0 ? rows * (cellH + gap) - gap : 0,
      };
    }
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- layout
```

Expected: PASS(5件)。座標の期待値がずれた場合はテストの前提(ラベル高さ、gap)と実装の対応を見直して整合させる。

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/layout/layout.ts src/layout/layout.test.ts
git commit -m "feat: layout engine with binary-searched cell size"
```

---

### Task 8: render(Canvas描画、ヒットテスト、分割区画)

**Files:**
- Create: `src/render/hitTest.ts`, `src/render/split.ts`, `src/render/renderer.ts`
- Test: `src/render/hitTest.test.ts`, `src/render/split.test.ts`

**Interfaces:**
- Consumes: `LayoutResult`, `LayoutCell`(Task 7)、`MetricInfo`, `chooseCellText`(Task 6)
- Produces:
  - `hitTest(layout: LayoutResult, x: number, y: number): LayoutCell | null`
  - `splitRects(n: number): Array<{ x: number; y: number; w: number; h: number }>` — 相対座標(0..1)。n≦1は全面1区画、2=2列、3=3列、4=2×2、5〜6=3×2、7〜9=3×3。**最大9区画**(10以上は先頭9つ)
  - `renderCanvas(canvas: HTMLCanvasElement, rc: RenderContext): void`
  - `RenderContext { layout: LayoutResult; metricInfos: MetricInfo[]; selectedRefId: string; displayMode: DisplayMode; showValues: boolean; missingColor: string; theme: GrafanaTheme2; scrollTop: number; viewportH: number }`
- renderCanvasは単体テスト対象外(E2Eと手動で検証)。ヒットテストと分割区画は純関数としてテストする

- [ ] **Step 1: 失敗するテストを書く**

`src/render/hitTest.test.ts`:

```ts
import { hitTest } from './hitTest';
import { LayoutResult } from '../layout/layout';

const layout: LayoutResult = {
  cells: [
    { x: 0, y: 0, w: 10, h: 10, cell: { path: ['a'], labels: {}, values: new Map() } },
    { x: 11, y: 0, w: 10, h: 10, cell: { path: ['b'], labels: {}, values: new Map() } },
  ],
  labels: [],
  borders: [],
  cellSize: 10,
  contentWidth: 21,
  contentHeight: 10,
  scrollable: false,
};

describe('hitTest', () => {
  it('returns the cell under the point', () => {
    expect(hitTest(layout, 5, 5)?.cell.path).toEqual(['a']);
    expect(hitTest(layout, 12, 3)?.cell.path).toEqual(['b']);
  });
  it('returns null on gaps and outside', () => {
    expect(hitTest(layout, 10.5, 5)).toBeNull();
    expect(hitTest(layout, 5, 50)).toBeNull();
  });
});
```

`src/render/split.test.ts`:

```ts
import { splitRects } from './split';

describe('splitRects', () => {
  it('single region for n<=1', () => {
    expect(splitRects(1)).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });
  it('two columns for n=2', () => {
    expect(splitRects(2)).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]);
  });
  it('2x2 for n=4', () => {
    const r = splitRects(4);
    expect(r).toHaveLength(4);
    expect(r[3]).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
  it('3x2 for n=5..6 and 3x3 for n=7..9', () => {
    expect(splitRects(6)).toHaveLength(6);
    expect(splitRects(6)[5]).toEqual({ x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 });
    expect(splitRects(9)).toHaveLength(9);
  });
  it('caps at 9 regions', () => {
    expect(splitRects(12)).toHaveLength(9);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- render
```

Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装**

`src/render/hitTest.ts`:

```ts
import { LayoutCell, LayoutResult } from '../layout/layout';

export function hitTest(layout: LayoutResult, x: number, y: number): LayoutCell | null {
  for (const c of layout.cells) {
    if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) {
      return c;
    }
  }
  return null;
}
```

`src/render/split.ts`:

```ts
export interface RelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_SPLIT = 9;

function gridFor(n: number): [number, number] {
  if (n <= 1) {
    return [1, 1];
  }
  if (n === 2) {
    return [2, 1];
  }
  if (n === 3) {
    return [3, 1];
  }
  if (n === 4) {
    return [2, 2];
  }
  if (n <= 6) {
    return [3, 2];
  }
  return [3, 3];
}

export function splitRects(n: number): RelRect[] {
  const m = Math.max(1, Math.min(n, MAX_SPLIT));
  const [cols, rows] = gridFor(m);
  return Array.from({ length: m }, (_, i) => ({
    x: (i % cols) / cols,
    y: Math.floor(i / cols) / rows,
    w: 1 / cols,
    h: 1 / rows,
  }));
}
```

`src/render/renderer.ts`(単体テストなし。E2E/手動検証):

```ts
import { GrafanaTheme2 } from '@grafana/data';
import { MetricInfo, chooseCellText } from '../data/display';
import { LayoutResult } from '../layout/layout';
import { DisplayMode } from '../types';
import { splitRects } from './split';

export interface RenderContext {
  layout: LayoutResult;
  metricInfos: MetricInfo[];
  selectedRefId: string;
  displayMode: DisplayMode;
  showValues: boolean;
  missingColor: string;
  theme: GrafanaTheme2;
  scrollTop: number;
  viewportH: number;
}

export function renderCanvas(canvas: HTMLCanvasElement, rc: RenderContext): void {
  const { layout, theme } = rc;
  const dpr = window.devicePixelRatio || 1;
  const cssW = layout.contentWidth;
  const cssH = Math.max(layout.contentHeight, rc.viewportH);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // 枠線
  ctx.strokeStyle = theme.colors.border.medium;
  for (const b of layout.borders) {
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  }

  // セル
  const infoByRef = new Map(rc.metricInfos.map((m) => [m.refId, m]));
  const selected = infoByRef.get(rc.selectedRefId) ?? rc.metricInfos[0];
  const split = rc.displayMode === 'split' && rc.metricInfos.length > 1;
  const rects = split ? splitRects(rc.metricInfos.length) : null;

  for (const c of layout.cells) {
    if (split && rects) {
      rc.metricInfos.slice(0, rects.length).forEach((info, i) => {
        const v = c.cell.values.get(info.refId) ?? null;
        ctx.fillStyle = v === null ? rc.missingColor : (info.processor(v).color ?? rc.missingColor);
        const r = rects[i];
        ctx.fillRect(c.x + r.x * c.w, c.y + r.y * c.h, r.w * c.w - 0.5, r.h * c.h - 0.5);
      });
      continue;
    }
    if (!selected) {
      continue;
    }
    const v = c.cell.values.get(selected.refId) ?? null;
    if (v === null) {
      ctx.fillStyle = rc.missingColor;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      continue;
    }
    const disp = selected.processor(v);
    ctx.fillStyle = disp.color ?? rc.missingColor;
    ctx.fillRect(c.x, c.y, c.w, c.h);

    if (rc.showValues) {
      const fit = chooseCellText(disp, c.w, c.h, (text, fontPx) => {
        ctx.font = `${fontPx}px ${theme.typography.fontFamily}`;
        return ctx.measureText(text).width;
      });
      if (fit) {
        ctx.font = `${fit.fontPx}px ${theme.typography.fontFamily}`;
        ctx.fillStyle = theme.colors.getContrastText(disp.color ?? rc.missingColor);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fit.text, c.x + c.w / 2, c.y + c.h / 2);
      }
    }
  }

  // グループラベル
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `${12}px ${theme.typography.fontFamily}`;
  ctx.fillStyle = theme.colors.text.primary;
  for (const l of layout.labels) {
    ctx.fillText(l.text, l.x + 2, l.y + l.h / 2, l.w - 4);
  }

  // スクロール時: 最上位レベルのラベルを上端に固定表示
  if (rc.scrollTop > 0) {
    const tops = layout.labels.filter((l) => l.depth === 1);
    const current = [...tops].reverse().find((l) => l.y <= rc.scrollTop);
    if (current) {
      ctx.fillStyle = theme.colors.background.primary;
      ctx.fillRect(current.x, rc.scrollTop, current.w, current.h);
      ctx.fillStyle = theme.colors.text.primary;
      ctx.fillText(current.text, current.x + 2, rc.scrollTop + current.h / 2, current.w - 4);
    }
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- render
```

Expected: PASS(hitTest 2件 + splitRects 5件)

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/render/
git commit -m "feat: canvas renderer, hit test and split-cell regions"
```

---

### Task 9: オプションエディタ(階層定義、Calculation)

**Files:**
- Create: `src/options/LevelsEditor.tsx`, `src/options/ReduceCalcEditor.tsx`
- Test: `src/options/LevelsEditor.test.tsx`

**Interfaces:**
- Consumes: `LevelDef`, `DEFAULT_LEVEL`(Task 2)、`extractKey`, `naturalCompare`(Task 4)
- Produces:
  - `LevelsEditor: React.FC<StandardEditorProps<LevelDef[]>>` — `context.data`(DataFrame[])からラベルキーを列挙。レベルの追加/削除/上下移動、各レベルの設定UI、グループ数+サンプル値のライブプレビュー
  - `ReduceCalcEditor: React.FC<StandardEditorProps<string>>` — `@grafana/ui` の `StatsPicker`(単一選択)の薄いラッパ
  - `detectLabelKeys(frames: DataFrame[]): string[]` — time series(field.labels)とtable(文字列列名)の両方からラベルキーを収集(export、テスト対象)
  - `previewLevel(frames: DataFrame[], level: LevelDef): { count: number; samples: string[] }`(export、テスト対象)

- [ ] **Step 1: 失敗するテストを書く**

`src/options/LevelsEditor.test.tsx`:

```ts
import { toDataFrame, FieldType } from '@grafana/data';
import { DEFAULT_LEVEL } from '../types';
import { detectLabelKeys, previewLevel } from './LevelsEditor';

const tsFrame = toDataFrame({
  refId: 'A',
  fields: [
    { name: 'Time', type: FieldType.time, values: [1] },
    { name: 'Value', type: FieldType.number, values: [1], labels: { zone: 'zone-a', gpu: '0' } },
  ],
});
const tableFrame = toDataFrame({
  refId: 'B',
  fields: [
    { name: 'host', type: FieldType.string, values: ['node-a001', 'node-a002', 'node-a001'] },
    { name: 'Value', type: FieldType.number, values: [1, 2, 3] },
  ],
});

describe('detectLabelKeys', () => {
  it('collects label keys from series labels and table string columns', () => {
    expect(detectLabelKeys([tsFrame, tableFrame]).sort()).toEqual(['gpu', 'host', 'zone']);
  });
});

describe('previewLevel', () => {
  it('counts distinct extracted keys with samples in natural order', () => {
    const p = previewLevel([tableFrame], { ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' });
    expect(p.count).toBe(2);
    expect(p.samples).toEqual(['001', '002']);
  });
  it('returns zero when nothing matches', () => {
    const p = previewLevel([tableFrame], {
      ...DEFAULT_LEVEL,
      label: 'host',
      extract: 'regex',
      regex: 'nomatch-(\\d+)',
    });
    expect(p.count).toBe(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- LevelsEditor
```

Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装**

`src/options/LevelsEditor.tsx`(核心部。UI詳細は`@grafana/ui`の既存コンポーネントで組む):

```tsx
import React from 'react';
import { DataFrame, FieldType, SelectableValue, StandardEditorProps } from '@grafana/data';
import { Button, IconButton, InlineField, InlineFieldRow, Input, RadioButtonGroup, Select, Switch } from '@grafana/ui';
import { DEFAULT_LEVEL, ExtractPreset, LevelDef, LevelLayout, SortOrder } from '../types';
import { extractKey, naturalCompare } from '../data/hierarchy';

export function detectLabelKeys(frames: DataFrame[]): string[] {
  const keys = new Set<string>();
  for (const frame of frames) {
    const hasTime = frame.fields.some((f) => f.type === FieldType.time);
    for (const field of frame.fields) {
      if (field.type === FieldType.number && field.labels) {
        Object.keys(field.labels).forEach((k) => keys.add(k));
      }
      if (!hasTime && field.type === FieldType.string) {
        keys.add(field.name);
      }
    }
  }
  return [...keys];
}

export function previewLevel(frames: DataFrame[], level: LevelDef): { count: number; samples: string[] } {
  const found = new Set<string>();
  for (const frame of frames) {
    const hasTime = frame.fields.some((f) => f.type === FieldType.time);
    for (const field of frame.fields) {
      if (field.type === FieldType.number && field.labels && level.label in field.labels) {
        const key = extractKey(field.labels[level.label], level);
        if (key !== null) {
          found.add(key);
        }
      }
      if (!hasTime && field.type === FieldType.string && field.name === level.label) {
        for (const v of field.values) {
          const key = extractKey(String(v), level);
          if (key !== null) {
            found.add(key);
          }
        }
      }
    }
  }
  const sorted = [...found].sort(naturalCompare);
  return { count: sorted.length, samples: sorted.slice(0, 5) };
}

const EXTRACT_OPTIONS: Array<SelectableValue<ExtractPreset>> = [
  { value: 'raw', label: 'そのまま' },
  { value: 'trailingNumber', label: '末尾の数値' },
  { value: 'regex', label: '正規表現' },
];
const SORT_OPTIONS: Array<SelectableValue<SortOrder>> = [
  { value: 'natural', label: '昇順' },
  { value: 'naturalDesc', label: '降順' },
  { value: 'none', label: 'なし' },
];
const LAYOUT_OPTIONS: Array<SelectableValue<LevelLayout>> = [
  { value: 'vertical', label: '縦積み' },
  { value: 'horizontal', label: '横並び' },
  { value: 'flow', label: '折返し' },
  { value: 'grid', label: 'グリッド' },
];

export const LevelsEditor: React.FC<StandardEditorProps<LevelDef[]>> = ({ value, onChange, context }) => {
  const levels = value ?? [];
  const frames = context.data ?? [];
  const labelOptions = detectLabelKeys(frames).map((k) => ({ value: k, label: k }));

  const update = (i: number, patch: Partial<LevelDef>) => {
    const next = levels.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
    onChange(next);
  };
  const move = (i: number, dir: -1 | 1) => {
    const next = [...levels];
    const [item] = next.splice(i, 1);
    next.splice(i + dir, 0, item);
    onChange(next);
  };

  return (
    <div>
      {levels.map((level, i) => {
        const preview = level.label ? previewLevel(frames, level) : null;
        return (
          <div key={i} style={{ marginBottom: 12 }}>
            <InlineFieldRow>
              <InlineField label={`レベル ${i + 1}`}>
                <Select options={labelOptions} value={level.label} allowCustomValue onChange={(v) => update(i, { label: v.value ?? '' })} width={20} />
              </InlineField>
              <IconButton name="arrow-up" disabled={i === 0} onClick={() => move(i, -1)} tooltip="上へ" />
              <IconButton name="arrow-down" disabled={i === levels.length - 1} onClick={() => move(i, 1)} tooltip="下へ" />
              <IconButton name="trash-alt" onClick={() => onChange(levels.filter((_, idx) => idx !== i))} tooltip="削除" />
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="抽出">
                <RadioButtonGroup options={EXTRACT_OPTIONS} value={level.extract} onChange={(v) => update(i, { extract: v })} />
              </InlineField>
              {level.extract === 'regex' && (
                <InlineField label="正規表現">
                  <Input value={level.regex ?? ''} placeholder="node-.+?(\d+)" onChange={(e) => update(i, { regex: e.currentTarget.value })} />
                </InlineField>
              )}
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="ソート">
                <RadioButtonGroup options={SORT_OPTIONS} value={level.sort} onChange={(v) => update(i, { sort: v })} />
              </InlineField>
              <InlineField label="レイアウト">
                <RadioButtonGroup options={LAYOUT_OPTIONS} value={level.layout} onChange={(v) => update(i, { layout: v })} />
              </InlineField>
              {level.layout === 'grid' && (
                <InlineField label="列数">
                  <Input type="number" value={level.gridColumns ?? 1} onChange={(e) => update(i, { gridColumns: Number(e.currentTarget.value) })} width={8} />
                </InlineField>
              )}
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="枠線">
                <Switch value={level.showBorder} onChange={(e) => update(i, { showBorder: e.currentTarget.checked })} />
              </InlineField>
              <InlineField label="ラベル表示">
                <Switch value={level.showLabel} onChange={(e) => update(i, { showLabel: e.currentTarget.checked })} />
              </InlineField>
            </InlineFieldRow>
            {preview && (
              <div style={{ opacity: 0.8, fontSize: 12 }}>
                → {preview.count}グループ: {preview.samples.join(', ')}
                {preview.count > preview.samples.length ? ', …' : ''}
                {preview.count === 0 && ' (マッチしません。設定を確認してください)'}
              </div>
            )}
          </div>
        );
      })}
      <Button icon="plus" variant="secondary" onClick={() => onChange([...levels, { ...DEFAULT_LEVEL }])}>
        レベル追加
      </Button>
    </div>
  );
};
```

`src/options/ReduceCalcEditor.tsx`:

```tsx
import React from 'react';
import { StandardEditorProps } from '@grafana/data';
import { StatsPicker } from '@grafana/ui';

export const ReduceCalcEditor: React.FC<StandardEditorProps<string>> = ({ value, onChange }) => (
  <StatsPicker stats={value ? [value] : ['lastNotNull']} onChange={(stats) => onChange(stats[0] ?? 'lastNotNull')} allowMultiple={false} />
);
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- LevelsEditor
```

Expected: PASS(3件)

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/options/
git commit -m "feat: hierarchy levels editor with live preview"
```

---

### Task 10: パネル統合(単一モード)と手動確認

**Files:**
- Create: `src/data/model.ts`, `src/components/ClusterviewPanel.tsx`
- Modify: `src/module.ts`
- Test: `src/data/model.test.ts`

**Interfaces:**
- Consumes: Task 3〜9の全成果物
- Produces:
  - `PanelModel { root: HierarchyNode; warnings: string[]; metricInfos: MetricInfo[]; refIds: string[] }`
  - `buildModel(frames: DataFrame[], options: ClusterviewOptions, theme: GrafanaTheme2, timeZone: string): PanelModel`
  - `ClusterviewPanel: React.FC<PanelProps<ClusterviewOptions>>` — スクロールコンテナ+canvas+メトリクスセレクタ(RadioButtonGroup)。選択はローカルstate(初期値 `options.defaultMetric`)
  - `module.ts` — PanelPlugin登録。オプション: levels(LevelsEditor)/displayMode/defaultMetric/showValues/missingColor/spatialAggregation/reduceCalc(ReduceCalcEditor)

- [ ] **Step 1: buildModelの失敗するテストを書く**

`src/data/model.test.ts`:

```ts
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { DEFAULT_LEVEL } from '../types';
import { buildModel } from './model';

const theme = createTheme();
const options = {
  levels: [
    { ...DEFAULT_LEVEL, label: 'zone' },
    { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid' as const, gridColumns: 2 },
  ],
  displayMode: 'single' as const,
  showValues: true,
  missingColor: 'rgb(70,70,70)',
  spatialAggregation: 'max' as const,
  reduceCalc: 'lastNotNull',
};

const frame = (refId: string, zone: string, gpu: string, value: number) =>
  toDataFrame({
    refId,
    name: refId === 'A' ? 'power' : 'temp',
    fields: [
      { name: 'Time', type: FieldType.time, values: [1000] },
      { name: 'Value', type: FieldType.number, values: [value], labels: { zone, gpu } },
    ],
  });

describe('buildModel', () => {
  it('produces tree, metric infos and refIds end to end', () => {
    const m = buildModel([frame('A', 'zone-a', '0', 503), frame('B', 'zone-a', '0', 61)], options, theme, 'browser');
    expect(m.warnings).toEqual([]);
    expect(m.refIds).toEqual(['A', 'B']);
    expect(m.metricInfos.map((i) => i.refId)).toEqual(['A', 'B']);
    const leaf = m.root.children[0].children[0];
    expect(leaf.cell!.values.get('A')).toBe(503);
  });

  it('propagates hierarchy warnings', () => {
    const m = buildModel([frame('A', 'zone-a', '0', 1)], { ...options, levels: [{ ...DEFAULT_LEVEL, label: 'rack' }] }, theme, 'browser');
    expect(m.warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- model
```

Expected: FAIL(`./model` が存在しない)

- [ ] **Step 3: buildModelとパネルを実装**

`src/data/model.ts`:

```ts
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
  timeZone: string
): PanelModel {
  const rows = normalizeFrames(frames, options.reduceCalc || 'lastNotNull');
  const { root, warnings } = buildHierarchy(rows, options.levels);
  attachCells(root, rows, options.levels, options.spatialAggregation);
  const metricInfos = buildMetricInfos(frames, theme, timeZone);
  return { root, warnings, metricInfos, refIds: collectRefIds(rows) };
}
```

`src/components/ClusterviewPanel.tsx`:

```tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanelProps } from '@grafana/data';
import { RadioButtonGroup, useTheme2 } from '@grafana/ui';
import { ClusterviewOptions } from '../types';
import { buildModel } from '../data/model';
import { computeLayout } from '../layout/layout';
import { renderCanvas } from '../render/renderer';

const HEADER_H = 32;

export const ClusterviewPanel: React.FC<PanelProps<ClusterviewOptions>> = (props) => {
  const { data, width, height, options, timeZone } = props;
  const theme = useTheme2();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [selected, setSelected] = useState<string | undefined>(options.defaultMetric || undefined);

  const model = useMemo(
    () => buildModel(data.series, options, theme, timeZone),
    [data.series, options, theme, timeZone]
  );

  const showHeader = model.refIds.length > 1 && options.displayMode === 'single';
  const bodyH = height - (showHeader ? HEADER_H : 0);

  const layout = useMemo(
    () => computeLayout(model.root, options.levels, width, bodyH),
    [model.root, options.levels, width, bodyH]
  );

  const selectedRefId = selected && model.refIds.includes(selected) ? selected : model.refIds[0] ?? 'A';

  useEffect(() => {
    if (canvasRef.current) {
      renderCanvas(canvasRef.current, {
        layout,
        metricInfos: model.metricInfos,
        selectedRefId,
        displayMode: options.displayMode,
        showValues: options.showValues,
        missingColor: options.missingColor,
        theme,
        scrollTop,
        viewportH: bodyH,
      });
    }
  }, [layout, model, selectedRefId, options, theme, scrollTop, bodyH]);

  if (options.levels.length === 0) {
    return <p>パネルオプションで階層レベルを設定してください。</p>;
  }
  if (model.warnings.length > 0 && layout.cells.length === 0) {
    return (
      <div role="alert">
        {model.warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    );
  }

  return (
    <div style={{ width, height, overflow: 'hidden' }}>
      {showHeader && (
        <div style={{ height: HEADER_H }}>
          <RadioButtonGroup
            size="sm"
            options={model.metricInfos.map((m) => ({ value: m.refId, label: m.name }))}
            value={selectedRefId}
            onChange={setSelected}
          />
        </div>
      )}
      <div
        ref={scrollRef}
        style={{ width, height: bodyH, overflowY: layout.scrollable ? 'auto' : 'hidden', overflowX: 'hidden' }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
};
```

`src/module.ts`:

```ts
import { PanelPlugin } from '@grafana/data';
import { ClusterviewOptions } from './types';
import { ClusterviewPanel } from './components/ClusterviewPanel';
import { LevelsEditor } from './options/LevelsEditor';
import { ReduceCalcEditor } from './options/ReduceCalcEditor';

export const plugin = new PanelPlugin<ClusterviewOptions>(ClusterviewPanel).setPanelOptions((builder) =>
  builder
    .addCustomEditor({
      id: 'levels',
      path: 'levels',
      name: '階層レベル',
      category: ['Hierarchy'],
      editor: LevelsEditor,
      defaultValue: [],
    })
    .addRadio({
      path: 'displayMode',
      name: '表示モード',
      category: ['Display'],
      defaultValue: 'single',
      settings: {
        options: [
          { value: 'single', label: '単一' },
          { value: 'split', label: '分割セル' },
        ],
      },
    })
    .addTextInput({
      path: 'defaultMetric',
      name: '既定の表示メトリクス(refId)',
      category: ['Display'],
      defaultValue: '',
    })
    .addBooleanSwitch({ path: 'showValues', name: '数値表示', category: ['Display'], defaultValue: true })
    .addColorPicker({ path: 'missingColor', name: '欠損色', category: ['Display'], defaultValue: 'rgb(70,70,70)' })
    .addSelect({
      path: 'spatialAggregation',
      name: '空間集約',
      description: '同一セルに複数系列が落ちたときの集約',
      category: ['Data'],
      defaultValue: 'max',
      settings: {
        options: [
          { value: 'max', label: 'Max' },
          { value: 'mean', label: 'Mean' },
          { value: 'min', label: 'Min' },
          { value: 'sum', label: 'Sum' },
        ],
      },
    })
    .addCustomEditor({
      id: 'reduceCalc',
      path: 'reduceCalc',
      name: 'Calculation',
      description: 'rangeクエリを現在値に畳む計算',
      category: ['Data'],
      editor: ReduceCalcEditor,
      defaultValue: 'lastNotNull',
    })
);
```

scaffoldが生成した旧 `src/panels` 系ファイル(SimplePanel等)は削除する。

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- model
npm run test:ci
```

Expected: PASS(既存テスト含め全件)

- [ ] **Step 5: 開発サーバーで手動確認**

```bash
npm run dev &   # watchビルド
npm run server  # docker composeでGrafana起動(初回はイメージ取得あり)
```

http://localhost:3000 で新規ダッシュボードを作り、TestDataデータソースのCSV Content(下記)でパネルを表示する:

```csv
zone,host,gpu,power
zone-a,node-a001,0,503
zone-a,node-a001,1,480
zone-a,node-a002,0,610
zone-b,node-b001,0,700
```

確認項目: (1) 階層レベル(zone→host→gpu)を設定するとグリッドが描画される、(2) Color schemeを `Green-Yellow-Red (by value)` にすると連続配色になる、(3) パネルリサイズでセルサイズが追従する、(4) セルに数値が表示される(小さくすると消える)。結果をスクリーンショットで記録する。

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "feat: integrate panel with single-metric mode and metric selector"
```

---

### Task 11: ホバーツールチップ

**Files:**
- Create: `src/components/CellTooltip.tsx`
- Modify: `src/components/ClusterviewPanel.tsx`
- Test: `src/components/CellTooltip.test.tsx`

**Interfaces:**
- Consumes: `CellModel`(Task 2)、`MetricInfo`(Task 6)、`hitTest`(Task 8)
- Produces: `CellTooltip: React.FC<{ cell: CellModel; metricInfos: MetricInfo[]; missingColor: string; x: number; y: number }>` — 階層パスと全メトリクスの「色ドット+名前+整形値(欠損は「欠損」)」を表示

- [ ] **Step 1: 失敗するテストを書く**

`src/components/CellTooltip.test.tsx`:

```tsx
import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos } from '../data/display';
import { CellTooltip } from './CellTooltip';

const theme = createTheme();
const frames = [
  toDataFrame({
    refId: 'A',
    name: 'power',
    fields: [
      { name: 'Time', type: FieldType.time, values: [1] },
      { name: 'Value', type: FieldType.number, values: [503], labels: { zone: 'zone-a' }, config: { unit: 'watt' } },
    ],
  }),
  toDataFrame({
    refId: 'B',
    name: 'temp',
    fields: [
      { name: 'Time', type: FieldType.time, values: [1] },
      { name: 'Value', type: FieldType.number, values: [61], labels: { zone: 'zone-a' } },
    ],
  }),
];

describe('CellTooltip', () => {
  it('shows path and all metric values including missing', () => {
    const infos = buildMetricInfos(frames, theme, 'browser');
    const cell = {
      path: ['zone-a', '0'],
      labels: { zone: 'zone-a' },
      values: new Map<string, number | null>([
        ['A', 503],
        ['B', null],
      ]),
    };
    render(<CellTooltip cell={cell} metricInfos={infos} missingColor="#444" x={0} y={0} />);
    expect(screen.getByText('zone-a / 0')).toBeInTheDocument();
    expect(screen.getByText(/503/)).toBeInTheDocument();
    expect(screen.getByText('power')).toBeInTheDocument();
    expect(screen.getByText('欠損')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- CellTooltip
```

Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装**

`src/components/CellTooltip.tsx`:

```tsx
import React from 'react';
import { CellModel } from '../types';
import { MetricInfo } from '../data/display';

export interface CellTooltipProps {
  cell: CellModel;
  metricInfos: MetricInfo[];
  missingColor: string;
  x: number;
  y: number;
}

export const CellTooltip: React.FC<CellTooltipProps> = ({ cell, metricInfos, missingColor, x, y }) => (
  <div
    style={{
      position: 'absolute',
      left: x + 12,
      top: y + 12,
      zIndex: 10,
      pointerEvents: 'none',
      padding: '6px 8px',
      borderRadius: 3,
      background: 'rgba(24,27,31,0.95)',
      color: '#d8d9da',
      fontSize: 12,
      whiteSpace: 'nowrap',
    }}
  >
    <div style={{ fontWeight: 600, marginBottom: 4 }}>{cell.path.join(' / ')}</div>
    {metricInfos.map((info) => {
      const v = cell.values.get(info.refId) ?? null;
      const disp = v === null ? null : info.processor(v);
      return (
        <div key={info.refId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: disp?.color ?? missingColor,
              display: 'inline-block',
            }}
          />
          <span>{info.name}</span>
          <span style={{ marginLeft: 'auto' }}>{disp ? `${disp.text}${disp.suffix ?? ''}` : '欠損'}</span>
        </div>
      );
    })}
  </div>
);
```

`src/components/ClusterviewPanel.tsx` に配線を追加(スクロールコンテナ内、canvasの後に):

```tsx
// 追加state
const [hover, setHover] = useState<{ cell: CellModel; x: number; y: number } | null>(null);

// スクロールコンテナのdivに追加
onMouseMove={(e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top + e.currentTarget.scrollTop;
  const hit = hitTest(layout, cx, cy);
  setHover(hit ? { cell: hit.cell, x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
}}
onMouseLeave={() => setHover(null)}

// コンテナをposition:relativeにし、末尾に:
{hover && (
  <CellTooltip cell={hover.cell} metricInfos={model.metricInfos} missingColor={options.missingColor} x={hover.x} y={hover.y} />
)}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci -- CellTooltip && npm run test:ci
```

Expected: PASS

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/components/
git commit -m "feat: hover tooltip with all metric values"
```

---

### Task 12: クリック(Data Links優先、ポップオーバー、手元rangeデータのスパークライン)

**Files:**
- Create: `src/drilldown/series.ts`, `src/components/DrilldownPopover.tsx`
- Modify: `src/components/ClusterviewPanel.tsx`
- Test: `src/drilldown/series.test.ts`, `src/components/DrilldownPopover.test.tsx`

**Interfaces:**
- Consumes: `CellModel.labels`(Task 5)、`MetricInfo`(Task 6)
- Produces:
  - `findSeriesFrame(frames: DataFrame[], refId: string, labels: Record<string,string>): DataFrame | null` — refIdが一致し、数値フィールドの `field.labels` がセルのlabelsをすべて含むフレーム。時間フィールドが2点以上あるもののみ(スパークライン用)
  - `getCellLinks(frames: DataFrame[], refId: string, labels: Record<string,string>): Array<{ href: string; target?: string }>` — 該当系列フィールドの `getLinks?.({ valueRowIndex: 最終行 })` を返す。なければ `[]`
  - `DrilldownPopover: React.FC<{ cell; metricInfos; frameFor: (refId: string) => DataFrame | null; loading: boolean; x; y; panelWidth; panelHeight; onClose }>` — メトリクスごとに「名前+現在値+スパークライン」の行。フレームがなくloading中は「読み込み中…」、loadingが終わってもなければ「時系列なし」

- [ ] **Step 1: 失敗するテストを書く**

`src/drilldown/series.test.ts`:

```ts
import { toDataFrame, FieldType } from '@grafana/data';
import { findSeriesFrame, getCellLinks } from './series';

const frame = (refId: string, labels: Record<string, string>, values: number[]) =>
  toDataFrame({
    refId,
    fields: [
      { name: 'Time', type: FieldType.time, values: values.map((_, i) => i * 1000) },
      { name: 'Value', type: FieldType.number, values, labels },
    ],
  });

describe('findSeriesFrame', () => {
  const frames = [
    frame('A', { zone: 'zone-a', gpu: '0' }, [1, 2]),
    frame('A', { zone: 'zone-a', gpu: '1' }, [3, 4]),
    frame('B', { zone: 'zone-a', gpu: '0' }, [5, 6]),
  ];
  it('matches refId and all cell labels', () => {
    const f = findSeriesFrame(frames, 'A', { zone: 'zone-a', gpu: '1' });
    expect(f).not.toBeNull();
    expect(f!.fields[1].values[0]).toBe(3);
  });
  it('returns null for single-point series', () => {
    expect(findSeriesFrame([frame('A', { zone: 'zone-a' }, [1])], 'A', { zone: 'zone-a' })).toBeNull();
  });
});

describe('getCellLinks', () => {
  it('returns links from field.getLinks when configured', () => {
    const f = frame('A', { zone: 'zone-a' }, [1, 2]);
    f.fields[1].getLinks = () => [{ href: 'https://example.com/d/abc', target: '_blank', title: '', origin: {} as any }];
    expect(getCellLinks([f], 'A', { zone: 'zone-a' })).toEqual([{ href: 'https://example.com/d/abc', target: '_blank' }]);
  });
  it('returns empty array without links', () => {
    expect(getCellLinks([frame('A', { zone: 'zone-a' }, [1, 2])], 'A', { zone: 'zone-a' })).toEqual([]);
  });
});
```

`src/components/DrilldownPopover.test.tsx`(Sparklineはcanvas依存のためスタブする):

```tsx
import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos } from '../data/display';
import { DrilldownPopover } from './DrilldownPopover';

jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
}));

const theme = createTheme();
const rangeFrame = toDataFrame({
  refId: 'A',
  name: 'power',
  fields: [
    { name: 'Time', type: FieldType.time, values: [1000, 2000] },
    { name: 'Value', type: FieldType.number, values: [500, 503], labels: { zone: 'zone-a' } },
  ],
});

describe('DrilldownPopover', () => {
  const cell = { path: ['zone-a'], labels: { zone: 'zone-a' }, values: new Map<string, number | null>([['A', 503]]) };
  it('renders a sparkline row per metric', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} frameFor={() => rangeFrame} loading={false} x={0} y={0} panelWidth={800} panelHeight={600} onClose={() => {}} />
    );
    expect(screen.getByText('zone-a')).toBeInTheDocument();
    expect(screen.getByText('power')).toBeInTheDocument();
    expect(screen.getByTestId('sparkline')).toBeInTheDocument();
  });
  it('shows loading state', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} frameFor={() => null} loading={true} x={0} y={0} panelWidth={800} panelHeight={600} onClose={() => {}} />
    );
    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- series
npm run test:ci -- DrilldownPopover
```

Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装**

`src/drilldown/series.ts`:

```ts
import { DataFrame, FieldType } from '@grafana/data';

function labelsMatch(fieldLabels: Record<string, string> | undefined, want: Record<string, string>): boolean {
  if (!fieldLabels) {
    return Object.keys(want).length === 0;
  }
  return Object.entries(want).every(([k, v]) => fieldLabels[k] === v);
}

export function findSeriesFrame(
  frames: DataFrame[],
  refId: string,
  labels: Record<string, string>
): DataFrame | null {
  for (const frame of frames) {
    if ((frame.refId ?? 'A') !== refId) {
      continue;
    }
    const time = frame.fields.find((f) => f.type === FieldType.time);
    if (!time || frame.length < 2) {
      continue;
    }
    const value = frame.fields.find((f) => f.type === FieldType.number && labelsMatch(f.labels, labels));
    if (value) {
      return frame;
    }
  }
  return null;
}

export function getCellLinks(
  frames: DataFrame[],
  refId: string,
  labels: Record<string, string>
): Array<{ href: string; target?: string }> {
  for (const frame of frames) {
    if ((frame.refId ?? 'A') !== refId) {
      continue;
    }
    const field = frame.fields.find((f) => f.type === FieldType.number && labelsMatch(f.labels, labels));
    if (field?.getLinks && (field.config.links?.length ?? 0) > 0) {
      return field
        .getLinks({ valueRowIndex: Math.max(0, field.values.length - 1) })
        .map((l) => ({ href: l.href, target: l.target }));
    }
  }
  return [];
}
```

`src/components/DrilldownPopover.tsx`:

```tsx
import React from 'react';
import { FieldType } from '@grafana/data';
import { Sparkline, useTheme2 } from '@grafana/ui';
import { CellModel } from '../types';
import { MetricInfo } from '../data/display';

const W = 280;
const ROW_H = 34;

export interface DrilldownPopoverProps {
  cell: CellModel;
  metricInfos: MetricInfo[];
  frameFor: (refId: string) => import('@grafana/data').DataFrame | null;
  loading: boolean;
  x: number;
  y: number;
  panelWidth: number;
  panelHeight: number;
  onClose: () => void;
}

export const DrilldownPopover: React.FC<DrilldownPopoverProps> = (props) => {
  const theme = useTheme2();
  const h = 40 + props.metricInfos.length * ROW_H;
  const left = Math.min(props.x, props.panelWidth - W - 8);
  const top = Math.min(props.y, props.panelHeight - h - 8);

  return (
    <div
      style={{
        position: 'absolute',
        left: Math.max(0, left),
        top: Math.max(0, top),
        width: W,
        zIndex: 20,
        padding: 8,
        borderRadius: 4,
        background: theme.colors.background.elevated ?? theme.colors.background.secondary,
        border: `1px solid ${theme.colors.border.medium}`,
        boxShadow: theme.shadows.z3,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>{props.cell.path.join(' / ')}</strong>
        <button onClick={props.onClose} aria-label="閉じる" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>
          ×
        </button>
      </div>
      {props.metricInfos.map((info) => {
        const v = props.cell.values.get(info.refId) ?? null;
        const disp = v === null ? null : info.processor(v);
        const frame = props.frameFor(info.refId);
        const yField = frame?.fields.find((f) => f.type === FieldType.number);
        const xField = frame?.fields.find((f) => f.type === FieldType.time);
        return (
          <div key={info.refId} style={{ display: 'flex', alignItems: 'center', gap: 8, height: ROW_H }}>
            <span style={{ width: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.name}</span>
            <span style={{ width: 60, textAlign: 'right' }}>{disp ? `${disp.text}${disp.suffix ?? ''}` : '欠損'}</span>
            <span style={{ flex: 1 }}>
              {yField && xField ? (
                <Sparkline width={120} height={ROW_H - 8} sparkline={{ y: yField, x: xField }} theme={theme} />
              ) : props.loading ? (
                <span style={{ opacity: 0.7 }}>読み込み中…</span>
              ) : (
                <span style={{ opacity: 0.7 }}>時系列なし</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
};
```

`src/components/ClusterviewPanel.tsx` に配線を追加:

```tsx
// 追加state
const [popover, setPopover] = useState<{ cell: CellModel; x: number; y: number } | null>(null);

// スクロールコンテナに追加
onClick={(e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top + e.currentTarget.scrollTop;
  const hit = hitTest(layout, cx, cy);
  if (!hit) {
    setPopover(null);
    return;
  }
  const links = getCellLinks(data.series, selectedRefId, hit.cell.labels);
  if (links.length > 0) {
    window.open(links[0].href, links[0].target ?? '_self');
    return;
  }
  setPopover({ cell: hit.cell, x: e.clientX - rect.left, y: e.clientY - rect.top });
}}

// Escで閉じる
useEffect(() => {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPopover(null);
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, []);

// 描画(この時点ではrangeデータのみ対応。requeryはTask 13)
{popover && (
  <DrilldownPopover
    cell={popover.cell}
    metricInfos={model.metricInfos}
    frameFor={(refId) => findSeriesFrame(data.series, refId, popover.cell.labels)}
    loading={false}
    x={popover.x}
    y={popover.y}
    panelWidth={width}
    panelHeight={bodyH}
    onClose={() => setPopover(null)}
  />
)}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci
```

Expected: PASS(全件)

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/drilldown/ src/components/
git commit -m "feat: click drilldown popover with data links priority"
```

---

### Task 13: instantクエリ時の再クエリとキャッシュ

**Files:**
- Create: `src/drilldown/requery.ts`
- Modify: `src/components/ClusterviewPanel.tsx`
- Test: `src/drilldown/requery.test.ts`

**Interfaces:**
- Consumes: `PanelProps.data.request`(`DataQueryRequest`)
- Produces:
  - `buildDrilldownRequest(base: DataQueryRequest): DataQueryRequest` — `maxDataPoints: 100`、`intervalMs: max(15000, range/100)`、全targetsを `{ ...t, instant: false, range: true }` に変換、requestIdに `-drilldown` を付与
  - `fetchDrilldownFrames(base: DataQueryRequest): Promise<DataFrame[]>` — `getDataSourceSrv().get(targets[0].datasource)` → `ds.query()` をawaitしてフレーム配列を返す
  - パネル側キャッシュ: `data.request.requestId` が変わるまで結果を保持(useRef)。ポップオーバーを開いたとき、いずれかのメトリクスで手元に時系列がなければ1回だけ実行

- [ ] **Step 1: 失敗するテストを書く**

`src/drilldown/requery.test.ts`:

```ts
import { dateTime } from '@grafana/data';
import { buildDrilldownRequest, fetchDrilldownFrames } from './requery';

const baseRequest = {
  requestId: 'Q100',
  interval: '30s',
  intervalMs: 30000,
  maxDataPoints: 1000,
  range: { from: dateTime(0), to: dateTime(3600_000), raw: { from: 'now-1h', to: 'now' } },
  scopedVars: {},
  targets: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'ds1' }, instant: true, range: false }],
  timezone: 'browser',
  app: 'dashboard',
  startTime: 0,
} as any;

describe('buildDrilldownRequest', () => {
  it('converts targets to range queries with capped data points', () => {
    const req = buildDrilldownRequest(baseRequest);
    expect(req.maxDataPoints).toBe(100);
    expect(req.intervalMs).toBe(36000); // 3600s / 100 = 36s
    expect(req.requestId).toBe('Q100-drilldown');
    expect(req.targets[0]).toMatchObject({ instant: false, range: true });
  });
});

describe('fetchDrilldownFrames', () => {
  it('queries the datasource and returns frames', async () => {
    const frames = [{ refId: 'A', fields: [], length: 0 }];
    const { of } = jest.requireActual('rxjs');
    const getMock = jest.fn().mockResolvedValue({ query: () => of({ data: frames }) });
    jest.spyOn(require('@grafana/runtime'), 'getDataSourceSrv').mockReturnValue({ get: getMock } as any);
    const result = await fetchDrilldownFrames(baseRequest);
    expect(getMock).toHaveBeenCalledWith({ type: 'prometheus', uid: 'ds1' });
    expect(result).toBe(frames);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- requery
```

Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装**

`src/drilldown/requery.ts`:

```ts
import { DataFrame, DataQueryRequest } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';

const MAX_POINTS = 100;

export function buildDrilldownRequest(base: DataQueryRequest): DataQueryRequest {
  const spanMs = base.range.to.valueOf() - base.range.from.valueOf();
  const intervalMs = Math.max(15000, Math.floor(spanMs / MAX_POINTS));
  return {
    ...base,
    requestId: `${base.requestId}-drilldown`,
    maxDataPoints: MAX_POINTS,
    intervalMs,
    interval: `${Math.round(intervalMs / 1000)}s`,
    targets: base.targets.map((t) => ({ ...t, instant: false, range: true })),
  };
}

export async function fetchDrilldownFrames(base: DataQueryRequest): Promise<DataFrame[]> {
  const target = base.targets[0];
  if (!target) {
    return [];
  }
  const ds = await getDataSourceSrv().get(target.datasource);
  const response = await lastValueFrom(ds.query(buildDrilldownRequest(base)) as any);
  return ((response as { data?: DataFrame[] })?.data ?? []) as DataFrame[];
}
```

`src/components/ClusterviewPanel.tsx` に配線を追加:

```tsx
// 追加state/ref
const [drillFrames, setDrillFrames] = useState<DataFrame[] | null>(null);
const [drillLoading, setDrillLoading] = useState(false);
const drillCacheId = useRef<string | undefined>(undefined);

// パネルデータが更新されたらキャッシュ破棄
useEffect(() => {
  if (data.request?.requestId !== drillCacheId.current) {
    setDrillFrames(null);
  }
}, [data.request?.requestId]);

// ポップオーバーを開いたとき、手元に時系列がないメトリクスがあれば再クエリ(1パネル1回)
useEffect(() => {
  if (!popover || drillFrames || drillLoading || !data.request) {
    return;
  }
  const missing = model.metricInfos.some(
    (info) => !findSeriesFrame(data.series, info.refId, popover.cell.labels)
  );
  if (!missing) {
    return;
  }
  setDrillLoading(true);
  fetchDrilldownFrames(data.request)
    .then((frames) => {
      drillCacheId.current = data.request?.requestId;
      setDrillFrames(frames);
    })
    .finally(() => setDrillLoading(false));
}, [popover, drillFrames, drillLoading, data, model.metricInfos]);

// DrilldownPopoverのpropsを変更
frameFor={(refId) =>
  findSeriesFrame(data.series, refId, popover.cell.labels) ??
  (drillFrames ? findSeriesFrame(drillFrames, refId, popover.cell.labels) : null)
}
loading={drillLoading}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci
```

Expected: PASS(全件)

- [ ] **Step 5: 検証とコミット**

```bash
npm run typecheck && npm run lint && npm run test:ci
git add src/drilldown/ src/components/
git commit -m "feat: on-demand range requery for drilldown on instant queries"
```

---

### Task 14: 分割セルモードと凡例

**Files:**
- Create: `src/components/SplitLegend.tsx`
- Modify: `src/components/ClusterviewPanel.tsx`
- Test: `src/components/SplitLegend.test.tsx`

**Interfaces:**
- Consumes: `MetricInfo`(Task 6)、`MAX_SPLIT`(Task 8)。Canvas側の分割描画はTask 8のrendererで実装済み
- Produces: `SplitLegend: React.FC<{ metricInfos: MetricInfo[] }>` — 区画番号(1〜)+クエリ名の並び。`metricInfos.length > MAX_SPLIT` のとき「分割表示は9クエリまでです(N件は非表示)」を表示

- [ ] **Step 1: 失敗するテストを書く**

`src/components/SplitLegend.test.tsx`:

```tsx
import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos } from '../data/display';
import { SplitLegend } from './SplitLegend';

const theme = createTheme();
const frame = (refId: string, name: string) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1] },
      { name: 'Value', type: FieldType.number, values: [1], labels: {} },
    ],
  });

describe('SplitLegend', () => {
  it('lists region number and query name in order', () => {
    const infos = buildMetricInfos([frame('A', 'power'), frame('B', 'temp')], theme, 'browser');
    render(<SplitLegend metricInfos={infos} />);
    expect(screen.getByText('1: power')).toBeInTheDocument();
    expect(screen.getByText('2: temp')).toBeInTheDocument();
  });
  it('warns when more than 9 queries', () => {
    const infos = buildMetricInfos(
      Array.from({ length: 11 }, (_, i) => frame(String.fromCharCode(65 + i), `m${i}`)),
      theme,
      'browser'
    );
    render(<SplitLegend metricInfos={infos} />);
    expect(screen.getByText(/9クエリまで/)).toBeInTheDocument();
    expect(screen.getByText(/2件は非表示/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm run test:ci -- SplitLegend
```

Expected: FAIL(モジュールが存在しない)

- [ ] **Step 3: 実装**

`src/components/SplitLegend.tsx`:

```tsx
import React from 'react';
import { MetricInfo } from '../data/display';
import { MAX_SPLIT } from '../render/split';

export const SplitLegend: React.FC<{ metricInfos: MetricInfo[] }> = ({ metricInfos }) => {
  const shown = metricInfos.slice(0, MAX_SPLIT);
  const hidden = metricInfos.length - shown.length;
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
      {shown.map((info, i) => (
        <span key={info.refId}>{`${i + 1}: ${info.name}`}</span>
      ))}
      {hidden > 0 && <span style={{ opacity: 0.7 }}>{`分割表示は9クエリまでです(${hidden}件は非表示)`}</span>}
    </div>
  );
};
```

`src/components/ClusterviewPanel.tsx` のヘッダを変更(分割モード時はセレクタの代わりに凡例):

```tsx
const isSplit = options.displayMode === 'split' && model.refIds.length > 1;
const showHeader = model.refIds.length > 1;
// ...
{showHeader && (
  <div style={{ height: HEADER_H, display: 'flex', alignItems: 'center' }}>
    {isSplit ? (
      <SplitLegend metricInfos={model.metricInfos} />
    ) : (
      <RadioButtonGroup
        size="sm"
        options={model.metricInfos.map((m) => ({ value: m.refId, label: m.name }))}
        value={selectedRefId}
        onChange={setSelected}
      />
    )}
  </div>
)}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm run test:ci
```

Expected: PASS(全件)

- [ ] **Step 5: 開発サーバーで分割モードを手動確認**

Task 10のCSVデータに2つ目のクエリ(temp列を使うCSV)を追加し、表示モードを「分割セル」に切り替えて、(1) セルが左右2分割で描画される、(2) 凡例に「1: A, 2: B」相当が出る、(3) ツールチップに両方の値が出る、を確認しスクリーンショットを記録する。

- [ ] **Step 6: コミット**

```bash
git add src/components/ src/render/
git commit -m "feat: split-cell display mode with legend"
```

---

### Task 15: provisioningとE2Eテスト

**Files:**
- Create/Modify: `provisioning/dashboards/clusterview.json`(scaffoldのprovisioning構成に追加)
- Test: `tests/panel.spec.ts`(scaffoldのe2eディレクトリ構成に合わせる)

**Interfaces:**
- Consumes: ビルド済みプラグイン一式、docker-compose環境(Task 1)
- Produces: 再現可能な検証用ダッシュボードとスモークE2E

- [ ] **Step 1: provisioningダッシュボードを作る**

scaffoldのprovisioningにあるTestDataデータソース(なければ `provisioning/datasources/` に `uid: testdata` で追加)を使い、開発サーバー上でダッシュボードを手で組む:

- クエリA: TestData `CSV Content`(Task 10のCSV、power列)
- クエリB: TestData `CSV Content`(同じ行構成でtemp列: 55〜90程度の値)
- パネル: ClusterView。階層 zone(縦積み)→ host(グリッド3列)→ gpu(グリッド2列)。パネルタイトル「ClusterView」
- Field設定: Color scheme = Green-Yellow-Red (by value)、Unit: watt(override by query BでCelsius)

ダッシュボードをJSONエクスポートし、`provisioning/dashboards/clusterview.json` に保存する(`uid` は `clusterview-e2e` に固定)。

- [ ] **Step 2: E2Eスモークテストを書く**

`tests/panel.spec.ts`:

```ts
import { test, expect } from '@grafana/plugin-e2e';

test('provisioned dashboard renders the clusterview canvas', async ({
  gotoDashboardPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'clusterview.json' });
  const page = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await page.getPanelByTitle('ClusterView');
  await expect(panel.locator.locator('canvas')).toBeVisible();
});

test('metric selector switches without error', async ({ gotoDashboardPage, readProvisionedDashboard, page }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'clusterview.json' });
  const dashboardPage = await gotoDashboardPage({ uid: dashboard.uid });
  const panel = await dashboardPage.getPanelByTitle('ClusterView');
  await panel.locator.getByRole('radio').last().click({ force: true });
  await expect(panel.locator.locator('canvas')).toBeVisible();
});
```

- [ ] **Step 3: E2Eを実行**

```bash
npm run build
npm run server &   # Grafana + provisioning
npm run e2e
```

Expected: 2件PASS。セレクタのroleが実際のDOMと違う場合はPlaywright Inspectorで確認して修正する。

- [ ] **Step 4: 手動確認チェックリストを実施**

開発サーバー上で以下を確認し、結果とスクリーンショットを報告に残す:

1. グラデーション配色が値に追従する(閾値設定なしで)
2. Thresholdsに切り替えると離散色になる
3. Unit設定(watt / celsius)がセル数値とツールチップに反映される
4. natural sortの並び(001, 002, ..., 010)
5. ホバーツールチップに全メトリクス表示
6. クリックでポップオーバー+スパークライン(rangeクエリの場合)
7. instantクエリに変えてクリック → 再クエリで時系列が出る
8. Data Link(override by query)を設定するとクリックがリンク遷移になる
9. 分割セルモードの描画と凡例
10. パネル縮小時: 数値が消える → さらに縮小でスクロールが出る

- [ ] **Step 5: コミット**

```bash
git add provisioning/ tests/
git commit -m "test: provisioned dashboard and e2e smoke tests"
```

---

### Task 16: READMEと最終検証

**Files:**
- Modify: `README.md`(scaffold生成物を置き換え)

- [ ] **Step 1: READMEを書く**

構成(英語で記述。コード例のラベル名は一般名称を使う):

1. 概要と特徴(階層グリッド、標準カラースキーム、複数メトリクス、ドリルダウン)
2. 対応環境(Grafana >= 11.6.0、Prometheus / VictoriaMetrics)
3. クイックスタート: クエリ設定 → Hierarchyレベル設定(zone / host / gpuの例) → Color scheme選択
4. オプションリファレンス(Hierarchy / Display / Dataの表)
5. 複数メトリクス: 単一+セレクタ、分割セル、凡例
6. ドリルダウン: ポップオーバー、Data Links優先、instant時の再クエリの注意
7. 開発: `npm run dev` / `npm run server` / `npm run test:ci` / `npm run e2e`

- [ ] **Step 2: 最終検証**

```bash
npm run typecheck && npm run lint && npm run test:ci && npm run build
```

Expected: すべて成功。

- [ ] **Step 3: コミット**

```bash
git add README.md
git commit -m "docs: usage and development guide"
```

---

## 完了条件

- 全タスクのテストが通り、`npm run build` が成功している
- Task 15の手動確認チェックリスト10項目がすべて確認済み(結果はスクリーンショット付きで報告)
- 仕様書の「確定要件」8行すべてに対応する実装が存在する
