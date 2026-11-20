import { LayoutCell, LayoutLabel, LayoutResult, pinnedTopLabel } from '../layout/layout';

export function hitTest(layout: LayoutResult, x: number, y: number): LayoutCell | null {
  for (const c of layout.cells) {
    if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) {
      return c;
    }
  }
  return null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The rectangle spanned by two corner points, in any order. */
export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

// A cell is in the rectangle when the two overlap. The comparisons are strict, so a rectangle that only
// touches a cell's edge does not take it, and a rectangle with no width or height (a straight drag)
// takes the cells it crosses.
function overlaps(c: LayoutCell, r: Rect): boolean {
  return c.x < r.x + r.w && r.x < c.x + c.w && c.y < r.y + r.h && r.y < c.y + c.h;
}

// Bucket grid over the cells' top-left corners, in compressed-row form: the cells of bucket b are
// order[start[b]] .. order[start[b + 1] - 1], as indices into layout.cells.
interface CellGrid {
  minX: number;
  minY: number;
  bucketW: number;
  bucketH: number;
  cols: number;
  rows: number;
  /** Largest cell width and height: how far left of and above a rectangle an overlapping cell can start. */
  maxW: number;
  maxH: number;
  start: Int32Array;
  order: Int32Array;
}

// Buckets per cell the grid may use. One bucket is one cell wide and high while the layout is dense;
// a sparse layout (wide gaps, long label rows) gets larger buckets so the grid stays this small.
const BUCKETS_PER_CELL = 4;
const MIN_BUCKETS = 64;

const grids = new WeakMap<LayoutResult, CellGrid | null>();

const clampIndex = (value: number, count: number): number => Math.min(count - 1, Math.max(0, Math.floor(value)));

function buildGrid(cells: LayoutCell[]): CellGrid | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxW = 0;
  let maxH = 0;
  for (const c of cells) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
    maxW = Math.max(maxW, c.w);
    maxH = Math.max(maxH, c.h);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  let bucketW = Math.max(maxW, 1);
  let bucketH = Math.max(maxH, 1);
  const limit = Math.max(MIN_BUCKETS, BUCKETS_PER_CELL * cells.length);
  const wanted = (Math.floor(spanX / bucketW) + 1) * (Math.floor(spanY / bucketH) + 1);
  if (![minX, minY, maxW, maxH, wanted].every(Number.isFinite)) {
    // No cells, or coordinates that are not finite numbers (or overflow): cellsInRect scans instead.
    return null;
  }
  if (wanted > limit) {
    const scale = Math.sqrt(wanted / limit);
    bucketW *= scale;
    bucketH *= scale;
  }
  // Scaling both sides bounds the product only when both spans are large: cap each axis as well.
  const cols = Math.min(limit, Math.floor(spanX / bucketW) + 1);
  const rows = Math.min(Math.max(1, Math.floor(limit / cols)), Math.floor(spanY / bucketH) + 1);
  bucketW = Math.max(bucketW, spanX / cols);
  bucketH = Math.max(bucketH, spanY / rows);

  const bucketOf = (c: LayoutCell): number =>
    clampIndex((c.y - minY) / bucketH, rows) * cols + clampIndex((c.x - minX) / bucketW, cols);
  const start = new Int32Array(cols * rows + 1);
  for (const c of cells) {
    start[bucketOf(c) + 1]++;
  }
  for (let b = 0; b < cols * rows; b++) {
    start[b + 1] += start[b];
  }
  const next = start.slice(0, cols * rows);
  const order = new Int32Array(cells.length);
  cells.forEach((c, index) => {
    order[next[bucketOf(c)]++] = index;
  });
  return { minX, minY, bucketW, bucketH, cols, rows, maxW, maxH, start, order };
}

function gridFor(layout: LayoutResult): CellGrid | null {
  let grid = grids.get(layout);
  if (grid === undefined) {
    grid = buildGrid(layout.cells);
    grids.set(layout, grid);
  }
  return grid;
}

/**
 * The cells that overlap a rectangle (content coordinates), in layout order.
 *
 * A rubber-band drag asks this on every pointer move, so it does not scan every cell: the cells are
 * bucketed once per layout by their top-left corner, and a query reads only the buckets a matching
 * cell can start in. The cost follows the area of the rectangle, not the size of the grid.
 */
export function cellsInRect(layout: LayoutResult, rect: Rect): LayoutCell[] {
  const grid = gridFor(layout);
  if (!grid) {
    return layout.cells.filter((c) => overlaps(c, rect));
  }
  const { cols, rows, start, order } = grid;
  // A cell that overlaps the rectangle starts at most one cell size before it and before its far edge.
  const col0 = clampIndex((rect.x - grid.maxW - grid.minX) / grid.bucketW, cols);
  const col1 = clampIndex((rect.x + rect.w - grid.minX) / grid.bucketW, cols);
  const row0 = clampIndex((rect.y - grid.maxH - grid.minY) / grid.bucketH, rows);
  const row1 = clampIndex((rect.y + rect.h - grid.minY) / grid.bucketH, rows);
  const hits: number[] = [];
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const bucket = row * cols + col;
      for (let i = start[bucket]; i < start[bucket + 1]; i++) {
        if (overlaps(layout.cells[order[i]], rect)) {
          hits.push(order[i]);
        }
      }
    }
  }
  hits.sort((a, b) => a - b);
  return hits.map((index) => layout.cells[index]);
}

const contains = (l: LayoutLabel, x: number, y: number, top: number): boolean =>
  x >= l.x && x < l.x + l.w && y >= top && y < top + l.h;

/**
 * The group label under a point (content coordinates). The top-level label that the renderer pins to
 * the top edge while the panel is scrolled covers what lies under it, so it is tested first.
 */
export function labelAt(layout: LayoutResult, x: number, y: number, scrollTop = 0): LayoutLabel | null {
  const pinned = pinnedTopLabel(layout.labels, scrollTop);
  if (pinned && contains(pinned, x, y, scrollTop)) {
    return pinned;
  }
  for (const label of layout.labels) {
    if (contains(label, x, y, label.y)) {
      return label;
    }
  }
  return null;
}
