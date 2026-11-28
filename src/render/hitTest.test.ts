import { cellsInRect, hitTest, labelAt, rectFromPoints } from './hitTest';
import { LayoutCell, LayoutLabel, LayoutResult } from '../layout/layout';

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

// A 3 × 3 grid of 10px cells with a 1px gap: cell (col, row) spans [11 col, 11 col + 10) × [11 row, 11 row + 10).
const gridCell = (col: number, row: number): LayoutCell => ({
  x: col * 11,
  y: row * 11,
  w: 10,
  h: 10,
  cell: { path: [`${col},${row}`], labels: {}, values: new Map() },
});
const grid: LayoutResult = {
  cells: [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => gridCell(col, row))),
  labels: [],
  borders: [],
  cellSize: 10,
  contentWidth: 32,
  contentHeight: 32,
  scrollable: false,
};
const names = (cells: LayoutCell[]) => cells.map((c) => c.cell.path[0]);

describe('rectFromPoints', () => {
  it('normalizes a drag in any direction', () => {
    expect(rectFromPoints(30, 5, 10, 25)).toEqual({ x: 10, y: 5, w: 20, h: 20 });
    expect(rectFromPoints(10, 25, 30, 5)).toEqual({ x: 10, y: 5, w: 20, h: 20 });
    expect(rectFromPoints(3, 4, 3, 4)).toEqual({ x: 3, y: 4, w: 0, h: 0 });
  });
});

describe('cellsInRect', () => {
  it('returns the cells the rectangle overlaps, in layout order', () => {
    // From inside (0,0) to inside (1,1): the four cells it covers at least partly.
    expect(names(cellsInRect(grid, { x: 5, y: 5, w: 10, h: 10 }))).toEqual(['0,0', '1,0', '0,1', '1,1']);
    expect(names(cellsInRect(grid, { x: 0, y: 0, w: 32, h: 32 }))).toHaveLength(9);
    expect(names(cellsInRect(grid, { x: -100, y: -100, w: 1000, h: 1000 }))).toHaveLength(9);
  });

  it('does not take a cell that the rectangle only touches or that lies across a gap', () => {
    // Ends exactly on the left edge of column 1.
    expect(names(cellsInRect(grid, { x: 2, y: 2, w: 9, h: 2 }))).toEqual(['0,0']);
    // Lies inside the gap between column 0 and column 1.
    expect(cellsInRect(grid, { x: 10, y: 0, w: 1, h: 32 })).toEqual([]);
    expect(cellsInRect(grid, { x: 100, y: 100, w: 5, h: 5 })).toEqual([]);
  });

  it('takes the cells a straight line crosses (a rectangle without width or height)', () => {
    expect(names(cellsInRect(grid, { x: 5, y: 16, w: 20, h: 0 }))).toEqual(['0,1', '1,1', '2,1']);
    expect(names(cellsInRect(grid, { x: 16, y: 16, w: 0, h: 0 }))).toEqual(['1,1']);
  });

  it('agrees with a scan when cells differ in size and lie far apart', () => {
    const uneven: LayoutResult = {
      ...grid,
      cells: [
        { ...gridCell(0, 0), w: 300, h: 4 },
        { ...gridCell(0, 0), x: 5000, y: 90000 },
        { ...gridCell(0, 0), x: -40, y: -40 },
        gridCell(2, 2),
      ],
    };
    const rect = { x: -35, y: -35, w: 5100, h: 90100 };
    expect(cellsInRect(uneven, rect)).toEqual(uneven.cells);
    expect(cellsInRect(uneven, { x: 250, y: 1, w: 10, h: 1 })).toEqual([uneven.cells[0]]);
  });

  it('returns nothing for an empty layout or a rectangle that is not a number', () => {
    expect(cellsInRect({ ...grid, cells: [] }, { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
    expect(cellsInRect(grid, { x: Number.NaN, y: 0, w: 10, h: 10 })).toEqual([]);
  });
});

describe('labelAt', () => {
  const label = (text: string, y: number, depth: number, x = 0): LayoutLabel => ({
    text,
    path: [text],
    x,
    y,
    w: 100,
    h: 16,
    depth,
  });
  const labelled: LayoutResult = {
    ...grid,
    labels: [label('zone-a', 0, 1), label('node-a001', 20, 2), label('zone-b', 200, 1)],
  };

  it('returns the group label under the point', () => {
    expect(labelAt(labelled, 50, 8)?.text).toBe('zone-a');
    expect(labelAt(labelled, 99, 35)?.text).toBe('node-a001');
    expect(labelAt(labelled, 0, 200)?.text).toBe('zone-b');
  });

  it('returns null beside and between the labels', () => {
    expect(labelAt(labelled, 100, 8)).toBeNull();
    expect(labelAt(labelled, 50, 16)).toBeNull();
    expect(labelAt(labelled, 50, 100)).toBeNull();
  });

  it('finds the pinned top-level label at the top edge of a scrolled viewport', () => {
    // Scrolled to 60: zone-a is drawn pinned over y 60..76, where no label is laid out.
    expect(labelAt(labelled, 50, 65, 0)).toBeNull();
    expect(labelAt(labelled, 50, 65, 60)?.text).toBe('zone-a');
    // Its laid-out position still counts, and so do the other labels.
    expect(labelAt(labelled, 50, 8, 60)?.text).toBe('zone-a');
    // Scrolled past zone-b: that one is pinned now.
    expect(labelAt(labelled, 50, 255, 250)?.text).toBe('zone-b');
    // The pinned label covers what it is drawn over, here part of the second-level label at y 20..36.
    expect(labelAt(labelled, 50, 30, 25)?.text).toBe('zone-a');
    expect(labelAt(labelled, 50, 30, 10)?.text).toBe('node-a001');
  });
});
