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

  it('keeps the raw label as the representative even when the extracted key differs', () => {
    const trailing: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' }];
    const rows: NormalizedRow[] = [{ labels: { host: 'node-a017' }, value: 5, refId: 'A' }];
    const { root } = buildHierarchy(rows, trailing);
    attachCells(root, rows, trailing, 'max');
    const cell = root.children[0].cell!;
    expect(root.children[0].key).toBe('017'); // 抽出キー
    expect(cell.labels).toEqual({ host: 'node-a017' }); // 代表原値は抽出前のraw
    expect(cell.labelSets).toEqual([{ host: 'node-a017' }]);
  });

  it('retains all colliding raw label sets and aggregates their values into one cell', () => {
    // node-a017 と node-b017 はどちらも trailingNumber で "017" に抽出され同一セルに畳まれる。
    // セル値は両方を集約し、labelSets は両方の原値組を保持する(ドリルダウンの探索対象)。
    const trailing: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' }];
    const rows: NormalizedRow[] = [
      { labels: { host: 'node-a017' }, value: 10, refId: 'A' },
      { labels: { host: 'node-b017' }, value: 30, refId: 'A' },
    ];
    const { root } = buildHierarchy(rows, trailing);
    attachCells(root, rows, trailing, 'sum');
    const cell = root.children[0].cell!;
    expect(cell.values.get('A')).toBe(40); // 両系列を集約
    expect(cell.labelSets).toEqual([{ host: 'node-a017' }, { host: 'node-b017' }]);
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
