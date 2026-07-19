import { DEFAULT_LEVEL, LevelDef, HierarchyNode, CellModel } from '../types';
import { computeLayout, S_MIN, S_MAX, CELL_GAP, GROUP_GAP, BORDER_PAD, LABEL_H } from './layout';

const cell = (path: string[]): CellModel => ({ path, labels: {}, values: new Map([['A', 1]]) });

const leaf = (key: string, path: string[]): HierarchyNode => ({ key, path, children: [], cell: cell(path) });

function tree(zones: string[][], gpuKeys: string[]): HierarchyNode {
  // zones: [['zone-a'], ...] hang gpuKeys leaves under each zone
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
    // grid, 2 columns: (0,0),(s+gap,0),(0,s+gap),(s+gap,s+gap) + label row offset
    const s = r.cellSize;
    const xs = r.cells.map((c) => c.x).sort((a, b) => a - b);
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(s + CELL_GAP);
    expect(r.cells[0].y).toBe(LABEL_H); // Starts below the zone label
  });

  it('emits group labels for levels with showLabel', () => {
    const r = computeLayout(tree([['zone-a'], ['zone-b']], ['0']), levels, 800, 800);
    expect(r.labels.map((l) => l.text)).toEqual(['zone-a', 'zone-b']);
  });

  it('finds intermediate cell size by descending scan', () => {
    // 1 zone × 100 GPU, 10-column grid. With width 800, 800/10−gap ≒ 79 → doesn't overflow the width at S_MAX
    // Constrain the height to force a mid-range size: 10 rows × (s+1) + LABEL_H <= 200
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

  it('places children left-to-right in horizontal layout', () => {
    const cfg: LevelDef[] = [
      { ...DEFAULT_LEVEL, label: 'zone', layout: 'horizontal', showLabel: false },
      { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 1, showLabel: false },
    ];
    const r = computeLayout(tree([['z1'], ['z2']], ['0']), cfg, 800, 800);
    expect(r.cellSize).toBe(S_MAX);
    const cells = [...r.cells].sort((a, b) => a.x - b.x);
    expect(cells.map((c) => c.x)).toEqual([0, S_MAX + GROUP_GAP]); // GROUP_GAP between groups
    expect(cells.every((c) => c.y === 0)).toBe(true); // Same row
  });

  it('stacks children top-to-bottom in vertical layout with multiple children', () => {
    const cfg: LevelDef[] = [
      { ...DEFAULT_LEVEL, label: 'zone', layout: 'vertical', showLabel: false },
      { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 1, showLabel: false },
    ];
    const r = computeLayout(tree([['z1'], ['z2'], ['z3']], ['0']), cfg, 800, 800);
    const cells = [...r.cells].sort((a, b) => a.y - b.y);
    expect(cells.map((c) => c.y)).toEqual([0, S_MAX + GROUP_GAP, 2 * (S_MAX + GROUP_GAP)]);
    expect(cells.every((c) => c.x === 0)).toBe(true); // Same column
  });

  it('emits a padded border box around a bordered group and insets its cell', () => {
    const cfg: LevelDef[] = [
      { ...DEFAULT_LEVEL, label: 'zone', layout: 'vertical', showBorder: true, showLabel: false },
      { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 1, showLabel: false },
    ];
    const r = computeLayout(tree([['z1']], ['0']), cfg, 800, 800);
    expect(r.cellSize).toBe(S_MAX);
    expect(r.borders).toHaveLength(1);
    // border wraps the inner cells by BORDER_PAD (x,y,w,h,depth)
    expect(r.borders[0]).toMatchObject({
      x: 0,
      y: 0,
      w: S_MAX + BORDER_PAD * 2,
      h: S_MAX + BORDER_PAD * 2,
      depth: 1,
    });
    // Cells are offset by BORDER_PAD inside the border
    expect(r.cells[0]).toMatchObject({ x: BORDER_PAD, y: BORDER_PAD, w: S_MAX, h: S_MAX });
  });

  it('wraps children in flow layout', () => {
    const flow: LevelDef[] = [
      { ...DEFAULT_LEVEL, label: 'zone', layout: 'flow', showLabel: false },
      { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 1 },
    ];
    // 4 zones, 1 leaf each. Constraining the width to 2 groups' worth results in 2 rows
    const zones = [['z1'], ['z2'], ['z3'], ['z4']];
    const r = computeLayout(tree(zones, ['0']), flow, 2 * (S_MAX + 4) + 2, 800);
    const ys = new Set(r.cells.map((c) => c.y));
    expect(ys.size).toBe(2);
  });
});
