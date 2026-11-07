import fc from 'fast-check';
import { DEFAULT_LEVEL, LevelDef, NormalizedRow } from '../types';
import { buildHierarchy } from '../data/hierarchy';
import { attachCells } from '../data/values';
import { hitTest } from '../render/hitTest';
import { computeLayout, normalizeGridColumns, S_MAX, S_MIN } from './layout';
import { propertyParams } from '../testing/property';

// Nested flow layouts make "fits at size s" non-monotonic (see computeLayout), so the example
// tests in layout.test.ts cannot cover the configuration space. These properties run the real
// hierarchy → cells → layout → hit-test pipeline on random topologies, level settings and panel
// sizes and check the invariants the renderer and the pointer handling rely on.

const levelDef = (index: number) =>
  fc.record({
    layout: fc.constantFrom<LevelDef['layout']>('vertical', 'horizontal', 'flow', 'grid'),
    gridColumns: fc.oneof(fc.constant(undefined), fc.integer({ min: -1, max: 8 }), fc.double({ min: 0, max: 8 })),
    showBorder: fc.boolean(),
    showLabel: fc.boolean(),
  }).map((d): LevelDef => ({ ...DEFAULT_LEVEL, ...d, label: `l${index}` }));

/** 1-4 levels and up to 150 rows whose level labels take small values (so paths collide and nest). */
const topology = fc.integer({ min: 1, max: 4 }).chain((depth) =>
  fc.record({
    levels: fc.tuple(...Array.from({ length: depth }, (_, i) => levelDef(i))),
    paths: fc.array(fc.array(fc.integer({ min: 0, max: 11 }), { minLength: depth, maxLength: depth }), {
      maxLength: 150,
    }),
  })
);

const panelSize = fc.record({
  width: fc.integer({ min: 0, max: 1600 }),
  // Infinity is the Auto Grid fit-content path.
  height: fc.oneof(fc.integer({ min: 0, max: 1200 }), fc.constant(Number.POSITIVE_INFINITY)),
});

function pipeline(levels: LevelDef[], paths: number[][]) {
  const rows: NormalizedRow[] = paths.map((path) => ({
    labels: Object.fromEntries(path.map((v, i) => [`l${i}`, `node-${v}`])),
    value: 1,
    refId: 'A',
  }));
  const { root, leafPaths } = buildHierarchy(rows, levels);
  attachCells(root, rows, levels, 'max');
  return { root, leafCount: leafPaths.size };
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('computeLayout (properties)', () => {
  it('places every leaf once, inside the content box, without overlaps, and hit-tests back to it', () => {
    fc.assert(
      fc.property(topology, panelSize, ({ levels, paths }, { width, height }) => {
        const { root, leafCount } = pipeline(levels, paths);
        const r = computeLayout(root, levels, width, height);

        expect(r.cells).toHaveLength(leafCount);
        // Candidate sizes are S_MAX, S_MAX - 0.5, ..., S_MIN.
        expect(r.cellSize).toBeGreaterThanOrEqual(S_MIN);
        expect(r.cellSize).toBeLessThanOrEqual(S_MAX);
        expect(Number.isInteger(r.cellSize * 2)).toBe(true);
        if (!r.scrollable) {
          expect(r.contentHeight).toBeLessThanOrEqual(height);
        }
        if (height === Number.POSITIVE_INFINITY) {
          expect(r.scrollable).toBe(false);
        }

        r.cells.forEach((c, i) => {
          expect(c.w).toBe(r.cellSize);
          expect(c.h).toBe(r.cellSize);
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x + c.w).toBeLessThanOrEqual(r.contentWidth);
          expect(c.y + c.h).toBeLessThanOrEqual(r.contentHeight);
          for (let j = i + 1; j < r.cells.length; j++) {
            expect(overlaps(c, r.cells[j])).toBe(false);
          }
          expect(hitTest(r, c.x + c.w / 2, c.y + c.h / 2)).toBe(c);
        });

        // Group labels sit above their group's cells and never cover one.
        for (const label of r.labels) {
          expect(r.cells.some((c) => overlaps(label, c))).toBe(false);
        }
      }),
      propertyParams()
    );
  });
});

describe('normalizeGridColumns (properties)', () => {
  it('always yields a positive integer and keeps valid column counts', () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.constant(undefined)), (value) => {
        const cols = normalizeGridColumns(value);
        expect(Number.isInteger(cols)).toBe(true);
        expect(cols).toBeGreaterThanOrEqual(1);
        if (value !== undefined && Number.isFinite(value) && value >= 1) {
          expect(cols).toBe(Math.floor(value));
        }
      }),
      propertyParams()
    );
  });
});
