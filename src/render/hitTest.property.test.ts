import fc from 'fast-check';
import { DEFAULT_LEVEL, LevelDef, NormalizedRow } from '../types';
import { buildHierarchy } from '../data/hierarchy';
import { attachCells } from '../data/values';
import { computeLayout, LayoutCell, LayoutResult } from '../layout/layout';
import { cellsInRect, hitTest, labelAt, Rect, rectFromPoints } from './hitTest';
import { groupCells } from '../selection/selection';
import { propertyParams } from '../testing/property';

// cellsInRect answers from a bucket grid that is built per layout and sized from the cells' extent.
// Its contract is the scan it replaces: exactly the cells that overlap the rectangle, in layout
// order. The properties compare the two on arbitrary cell soups (any size, any distance apart, any
// rectangle, including coordinates large enough to overflow) and on the layouts the panel produces.

const overlaps = (c: LayoutCell, r: Rect) => c.x < r.x + r.w && r.x < c.x + c.w && c.y < r.y + r.h && r.y < c.y + c.h;
const scan = (layout: LayoutResult, rect: Rect) => layout.cells.filter((c) => overlaps(c, rect));

const layoutOf = (cells: Array<Omit<LayoutCell, 'cell'>>): LayoutResult => ({
  cells: cells.map((c, index) => ({ ...c, cell: { path: [String(index)], labels: {}, values: new Map() } })),
  labels: [],
  borders: [],
  cellSize: 10,
  contentWidth: 0,
  contentHeight: 0,
  scrollable: false,
});

// Coordinates on a coarse lattice (so edges coincide and rectangles touch), fractional ones, and
// rare huge ones.
const coordinate = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: -3, max: 60 }).map((n) => n * 5) },
  { weight: 3, arbitrary: fc.double({ min: -50, max: 400, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(-1e15, 1e15, 1e300, -1e300, 1e-9) }
);
const size = fc.oneof(
  fc.constantFrom(0, 5, 10, 40),
  fc.double({ min: 0, max: 60, noNaN: true }),
  fc.constantFrom(1e15, 1e300)
);
const rect = fc.record({ x: coordinate, y: coordinate, w: size, h: size });

describe('cellsInRect (properties)', () => {
  it('returns exactly the cells a scan finds, in layout order, for any cells and rectangle', () => {
    fc.assert(
      fc.property(
        fc.array(rect, { maxLength: 60 }),
        fc.array(rect, { minLength: 1, maxLength: 8 }),
        (cells, queries) => {
          const layout = layoutOf(cells);
          for (const query of queries) {
            expect(cellsInRect(layout, query)).toEqual(scan(layout, query));
          }
        }
      ),
      propertyParams()
    );
  });
});

const levelDef = (index: number) =>
  fc
    .record({
      layout: fc.constantFrom<LevelDef['layout']>('vertical', 'horizontal', 'flow', 'grid'),
      gridColumns: fc.integer({ min: 1, max: 8 }),
      showBorder: fc.boolean(),
      showLabel: fc.boolean(),
    })
    .map((d): LevelDef => ({ ...DEFAULT_LEVEL, ...d, label: `l${index}` }));

const topology = fc.integer({ min: 1, max: 3 }).chain((depth) =>
  fc.record({
    levels: fc.tuple(...Array.from({ length: depth }, (_, i) => levelDef(i))),
    paths: fc.array(fc.array(fc.integer({ min: 0, max: 9 }), { minLength: depth, maxLength: depth }), {
      minLength: 1,
      maxLength: 120,
    }),
    width: fc.integer({ min: 40, max: 1200 }),
    height: fc.integer({ min: 40, max: 900 }),
  })
);

function pipeline(levels: LevelDef[], paths: number[][], width: number, height: number) {
  const rows: NormalizedRow[] = paths.map((path) => ({
    labels: Object.fromEntries(path.map((v, i) => [`l${i}`, `node-${v}`])),
    value: 1,
    refId: 'A',
  }));
  const { root } = buildHierarchy(rows, levels);
  attachCells(root, rows, levels, 'max');
  return { root, layout: computeLayout(root, levels, width, height) };
}

describe('region and label hit tests on computed layouts (properties)', () => {
  it('a drag between two points selects what a scan selects, and the drag direction does not matter', () => {
    fc.assert(
      fc.property(
        topology,
        fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })), {
          minLength: 2,
          maxLength: 6,
        }),
        ({ levels, paths, width, height }, points) => {
          const { layout } = pipeline(levels, paths, width, height);
          const at = ([fx, fy]: [number, number]) => [fx * layout.contentWidth, fy * layout.contentHeight] as const;
          for (let i = 0; i + 1 < points.length; i++) {
            const [x1, y1] = at(points[i]);
            const [x2, y2] = at(points[i + 1]);
            const forward = cellsInRect(layout, rectFromPoints(x1, y1, x2, y2));
            expect(forward).toEqual(scan(layout, rectFromPoints(x1, y1, x2, y2)));
            expect(cellsInRect(layout, rectFromPoints(x2, y2, x1, y1))).toEqual(forward);
          }
          // The rectangle of a single cell selects that cell, and the whole content every cell.
          for (const c of layout.cells) {
            expect(cellsInRect(layout, c)).toContain(c);
            expect(cellsInRect(layout, { x: c.x + c.w / 2, y: c.y + c.h / 2, w: 0, h: 0 })).toEqual([c]);
          }
          expect(cellsInRect(layout, { x: 0, y: 0, w: layout.contentWidth, h: layout.contentHeight })).toEqual(
            layout.cells
          );
        }
      ),
      propertyParams()
    );
  });

  it('a group label hit-tests back to itself, names its cells, and never hides a cell', () => {
    fc.assert(
      fc.property(topology, ({ levels, paths, width, height }) => {
        const { root, layout } = pipeline(levels, paths, width, height);
        for (const label of layout.labels) {
          const x = label.x + label.w / 2;
          const y = label.y + label.h / 2;
          if (label.w > 0) {
            expect(labelAt(layout, x, y)).toBe(label);
            // Labels and cells do not overlap, so a point is on one or the other.
            expect(hitTest(layout, x, y)).toBeNull();
          }
          // The label's path names a group: its cells are exactly those whose path starts with it.
          const cells = groupCells(root, label.path);
          const expected = layout.cells
            .map((c) => c.cell)
            .filter((cell) => label.path.every((key, depth) => cell.path[depth] === key));
          expect(cells.length).toBeGreaterThan(0);
          expect(new Set(cells)).toEqual(new Set(expected));
          expect(label.path).toHaveLength(label.depth);
          expect(label.text).toBe(label.path[label.path.length - 1]);
        }
        for (const c of layout.cells) {
          expect(labelAt(layout, c.x + c.w / 2, c.y + c.h / 2)).toBeNull();
        }
      }),
      propertyParams()
    );
  });
});
