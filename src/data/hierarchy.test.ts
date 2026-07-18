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
  it('returns null for regex without capture group', () => {
    expect(extractKey('node-a004', level({ label: 'h', extract: 'regex', regex: 'node-a\\d+' }))).toBeNull();
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

  it('warns when only some rows match the hierarchy', () => {
    const mixed: NormalizedRow[] = [
      { labels: { zone: 'zone-a', gpu: '0' }, value: 1, refId: 'A' },
      { labels: { zone: 'zone-b' }, value: 2, refId: 'A' }, // gpuラベルなし
    ];
    const { warnings } = buildHierarchy(mixed, levels);
    expect(warnings.some((w) => w.includes('1/2'))).toBe(true);
  });

  it('collects label/extract stats across all levels when an earlier level fails', () => {
    // 全行が zone と gpu の両ラベルを持つが、level 0 の regex は全行アンマッチ
    const { warnings } = buildHierarchy(rows, [
      level({ label: 'zone', extract: 'regex', regex: 'nomatch-(\\d+)' }),
      level({ label: 'gpu' }),
    ]);
    // (a) gpu は全行に存在するため「クエリ結果にありません」の誤警告は出ない
    expect(warnings.some((w) => w.includes('"gpu"') && w.includes('クエリ結果にありません'))).toBe(false);
    // (b) level 0 のアンマッチ警告のみが出る(誤警告で件数が増えない)
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('マッチしません');
    expect(warnings[0]).toContain('zone');
  });

  it('excludes non-matching rows from leafPaths and tree with a full warning message', () => {
    const mixed: NormalizedRow[] = [
      { labels: { zone: 'zone-a', gpu: '0' }, value: 1, refId: 'A' },
      { labels: { zone: 'zone-b' }, value: 2, refId: 'A' }, // gpuラベルなし
    ];
    const { root, warnings, leafPaths } = buildHierarchy(mixed, levels);
    expect(warnings).toContain('1/2 行が階層にマッチせず除外されました');
    const leaves = [...leafPaths.values()];
    expect(leaves).toContainEqual(['zone-a', '0']);
    // 除外された行(zone-b)は leafPaths にもツリーにも現れない
    expect(leaves.some((p) => p.includes('zone-b'))).toBe(false);
    expect(root.children.map((c) => c.key)).toEqual(['zone-a']);
  });

  it('applies naturalDesc at a lower level', () => {
    const cfg = [level({ label: 'zone' }), level({ label: 'gpu', sort: 'naturalDesc' })];
    const { root } = buildHierarchy(rows, cfg);
    const zoneA = root.children.find((c) => c.key === 'zone-a');
    expect(zoneA?.children.map((c) => c.key)).toEqual(['10', '2']);
  });

  it('preserves insertion order when sort is none', () => {
    const cfg = [level({ label: 'zone', sort: 'none' }), level({ label: 'gpu' })];
    const { root } = buildHierarchy(rows, cfg);
    // 出現順(row0=zone-b, row1=zone-a)を保持する
    expect(root.children.map((c) => c.key)).toEqual(['zone-b', 'zone-a']);
  });
});
