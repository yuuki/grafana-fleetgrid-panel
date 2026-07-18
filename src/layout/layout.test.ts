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

  it('finds intermediate cell size by descending scan', () => {
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
