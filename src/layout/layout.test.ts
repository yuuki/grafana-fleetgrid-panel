import { DEFAULT_LEVEL, LevelDef, HierarchyNode, CellModel } from '../types';
import { computeLayout, S_MIN, S_MAX, CELL_GAP, GROUP_GAP, BORDER_PAD, LABEL_H } from './layout';

const cell = (path: string[]): CellModel => ({ path, labels: {}, values: new Map([['A', 1]]) });

const leaf = (key: string, path: string[]): HierarchyNode => ({ key, path, children: [], cell: cell(path) });

const oneLevelTree = (keys: string[]): HierarchyNode => ({
  key: '',
  path: [],
  children: keys.map((key) => leaf(key, [key])),
});

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

function nestedGridTree(podCount: number, hostCount: number, gpuCount: number): HierarchyNode {
  return {
    key: '',
    path: [],
    children: Array.from({ length: podCount }, (_, pod) => ({
      key: `pod${pod + 1}`,
      path: [`pod${pod + 1}`],
      children: Array.from({ length: hostCount }, (_, host) => ({
        key: String(host + 1).padStart(2, '0'),
        path: [`pod${pod + 1}`, String(host + 1).padStart(2, '0')],
        children: Array.from({ length: gpuCount }, (_, gpu) =>
          leaf(String(gpu), [`pod${pod + 1}`, String(host + 1).padStart(2, '0'), String(gpu)])
        ),
      })),
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

  it('lays out three hierarchy levels in row-major 2 / 8 / 2 column grids', () => {
    const cfg: LevelDef[] = [
      { ...DEFAULT_LEVEL, label: 'pod', layout: 'grid', gridColumns: 2, showLabel: false },
      { ...DEFAULT_LEVEL, label: 'host', layout: 'grid', gridColumns: 8, showLabel: false },
      { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 2, showLabel: false },
    ];
    const r = computeLayout(nestedGridTree(2, 9, 4), cfg, 2000, 1000);
    const position = (path: string[]) => {
      const found = r.cells.find((c) => c.cell.path.join('/') === path.join('/'));
      expect(found).toBeDefined();
      return { x: found!.x, y: found!.y };
    };

    expect(r.cellSize).toBe(S_MAX);
    expect(position(['pod1', '01', '0'])).toEqual({ x: 0, y: 0 });
    expect(position(['pod1', '01', '1'])).toEqual({ x: S_MAX + CELL_GAP, y: 0 });
    expect(position(['pod1', '01', '2'])).toEqual({ x: 0, y: S_MAX + CELL_GAP });
    expect(position(['pod1', '02', '0'])).toEqual({ x: 2 * S_MAX + CELL_GAP + GROUP_GAP, y: 0 });
    expect(position(['pod1', '09', '0'])).toEqual({ x: 0, y: 2 * S_MAX + CELL_GAP + GROUP_GAP });
    expect(position(['pod2', '01', '0']).x).toBeGreaterThan(position(['pod1', '08', '1']).x);

    const occupied = new Set(r.cells.map((c) => `${c.x},${c.y}`));
    expect(occupied.size).toBe(r.cells.length);
  });

  it('keeps an incomplete grid row and ignores columns beyond the child count', () => {
    const incomplete = [{ ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid' as const, gridColumns: 2 }];
    const wide = [{ ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid' as const, gridColumns: 8 }];
    const root = oneLevelTree(['0', '1', '2']);

    const incompleteResult = computeLayout(root, incomplete, 800, 800);
    expect(incompleteResult.cells.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: S_MAX + CELL_GAP, y: 0 },
      { x: 0, y: S_MAX + CELL_GAP },
    ]);

    const wideResult = computeLayout(root, wide, 800, 800);
    expect(wideResult.cells.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: S_MAX + CELL_GAP, y: 0 },
      { x: 2 * (S_MAX + CELL_GAP), y: 0 },
    ]);
  });

  it.each([undefined, 0, -2, Number.NaN, Number.POSITIVE_INFINITY])(
    'normalizes invalid grid column count %s to one column',
    (gridColumns) => {
      const cfg: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns }];
      const root = oneLevelTree(['0', '1', '2']);
      const r = computeLayout(root, cfg, 800, 800);

      expect(r.cells.map(({ x, y }) => ({ x, y }))).toEqual([
        { x: 0, y: 0 },
        { x: 0, y: S_MAX + CELL_GAP },
        { x: 0, y: 2 * (S_MAX + CELL_GAP) },
      ]);
    }
  );

  it('floors a fractional grid column count', () => {
    const cfg: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: 2.8 }];
    const root = oneLevelTree(['0', '1', '2']);
    const r = computeLayout(root, cfg, 800, 800);

    expect(r.cells.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: S_MAX + CELL_GAP, y: 0 },
      { x: 0, y: S_MAX + CELL_GAP },
    ]);
  });
});
