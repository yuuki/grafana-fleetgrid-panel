import fc from 'fast-check';
import { DEFAULT_LEVEL, HierarchyNode, LevelDef, NormalizedRow, SpatialAggregation } from '../types';
import { buildHierarchy, naturalCompare } from './hierarchy';
import { attachCells } from './values';
import { propertyParams } from '../testing/property';

// Model-based check of hierarchy + cell aggregation: a row lands in the cell of its label path,
// every cell carries every refId (union semantics, null when it has no sample), and the cell value
// is the spatial aggregation of exactly the non-null samples of that path and refId.

const levels: LevelDef[] = [
  { ...DEFAULT_LEVEL, label: 'zone', sort: 'natural' },
  { ...DEFAULT_LEVEL, label: 'host', sort: 'naturalDesc' },
];

const REF_IDS = ['A', 'B', 'C'];

// Values reach attachCells after normalizeFrames, so they are finite or null. Magnitudes are
// bounded so that a float sum cannot overflow, which would only test IEEE 754 arithmetic.
const row = fc.record({
  zone: fc.constantFrom('zone-a', 'zone-b', 'zone-a2', 'zone-a10'),
  host: fc.oneof(fc.constantFrom('node-1', 'node-2', 'node-10', 'Node-3'), fc.string({ maxLength: 3 })),
  refId: fc.constantFrom(...REF_IDS),
  value: fc.oneof(fc.double({ min: -1e9, max: 1e9, noNaN: true }), fc.constant(null)),
  // A row missing a hierarchy label must not produce a cell.
  dropHost: fc.boolean(),
});

type DrawnRow = typeof row extends fc.Arbitrary<infer T> ? T : never;

function toRows(drawn: DrawnRow[]): NormalizedRow[] {
  return drawn.map(
    (r): NormalizedRow => ({
      labels: r.dropHost ? { zone: r.zone } : { zone: r.zone, host: r.host },
      value: r.value,
      refId: r.refId,
    })
  );
}

function reference(rows: NormalizedRow[], agg: SpatialAggregation) {
  const byPath = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    if (r.labels.host === undefined) {
      continue;
    }
    const key = JSON.stringify([r.labels.zone, r.labels.host]);
    const byRef = byPath.get(key) ?? new Map<string, number[]>();
    byPath.set(key, byRef);
    if (r.value !== null) {
      byRef.set(r.refId, [...(byRef.get(r.refId) ?? []), r.value]);
    }
  }
  const fold = (vs: number[]) => {
    switch (agg) {
      case 'max':
        return vs.reduce((a, b) => Math.max(a, b));
      case 'min':
        return vs.reduce((a, b) => Math.min(a, b));
      case 'sum':
        return vs.reduce((a, b) => a + b, 0);
      case 'mean':
        return vs.reduce((a, b) => a + b, 0) / vs.length;
    }
  };
  return { byPath, fold };
}

function leaves(node: HierarchyNode): HierarchyNode[] {
  return node.children.length === 0 ? [node] : node.children.flatMap(leaves);
}

describe('buildHierarchy + attachCells (properties)', () => {
  it('routes each sample to the cell of its path and aggregates it like the reference model', () => {
    fc.assert(
      fc.property(
        fc.array(row, { maxLength: 60 }),
        fc.constantFrom<SpatialAggregation>('max', 'min', 'sum', 'mean'),
        (drawn, agg) => {
          const rows = toRows(drawn);
          const { root, warnings } = buildHierarchy(rows, levels);
          attachCells(root, rows, levels, agg, REF_IDS);
          const { byPath, fold } = reference(rows, agg);

          const cells = leaves(root).filter((n) => n.path.length === levels.length);
          expect(cells.map((n) => JSON.stringify(n.path)).sort()).toEqual([...byPath.keys()].sort());
          for (const node of cells) {
            const cell = node.cell!;
            const expected = byPath.get(JSON.stringify(node.path))!;
            expect([...cell.values.keys()]).toEqual(REF_IDS);
            for (const refId of REF_IDS) {
              const samples = expected.get(refId);
              expect(cell.values.get(refId)).toBe(samples ? fold(samples) : null);
            }
          }

          const excluded = rows.filter((r) => r.labels.host === undefined).length;
          if (excluded > 0) {
            expect(warnings).toContain(`${excluded}/${rows.length} rows did not match the hierarchy and were excluded`);
          }
        }
      ),
      propertyParams()
    );
  });

  it('orders every level by its natural sort setting', () => {
    fc.assert(
      fc.property(fc.array(row, { maxLength: 60 }), (drawn) => {
        const { root } = buildHierarchy(toRows(drawn), levels);
        const zones = root.children.map((c) => c.key);
        for (let i = 1; i < zones.length; i++) {
          expect(naturalCompare(zones[i - 1], zones[i])).toBeLessThanOrEqual(0);
        }
        for (const zone of root.children) {
          const hosts = zone.children.map((c) => c.key);
          for (let i = 1; i < hosts.length; i++) {
            expect(naturalCompare(hosts[i - 1], hosts[i])).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      propertyParams()
    );
  });
});
