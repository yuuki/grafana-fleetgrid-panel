import fc from 'fast-check';
import { FieldType, createTheme, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, FleetGridOptions, LevelDef, NormalizedRow, SpatialAggregation } from '../types';
import { buildHierarchy, pathKey } from './hierarchy';
import { attachCells } from './values';
import { FlowEdge, FlowModel, buildFlowModel, flowFocusEdges, resolveFlowConfig, summarizeFlowNode } from './edges';
import { propertyParams } from '../testing/property';

// Model-based check of the flow overlay's data stage: every edge-query row is either part of exactly
// one edge or counted under exactly one reason, an edge's value is the spatial aggregation of the
// finite values of its ordered pair (never 0 for "unknown"), and the ranking, the filter and the
// hover index agree with a naive reference.

const theme = createTheme();
const levels: LevelDef[] = [
  { ...DEFAULT_LEVEL, label: 'zone' },
  { ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' },
];

// node-a1 and node-b1 collide on the extracted key "1"; they must stay two nodes.
const KNOWN = ['node-a1', 'node-a2', 'node-b1', 'node-b2'];
const nodeOf = (host: string) => pathKey([`zone-${host[5]}`, host.slice(6)]);

const cellRows: NormalizedRow[] = KNOWN.map((host) => ({
  labels: { zone: `zone-${host[5]}`, host },
  value: 1,
  refId: 'A',
}));
const { root } = buildHierarchy(cellRows, levels);
attachCells(root, cellRows, levels, 'max');

// '' is a missing label, node-x9 matches no cell.
const endpoint = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(...KNOWN) },
  { weight: 1, arbitrary: fc.constant('node-x9') },
  { weight: 1, arbitrary: fc.constant('') }
);
// fc.double() includes NaN and ±Infinity: a data source can return them, and they are "unknown".
// Magnitudes are bounded so that a sum cannot overflow, which would only test IEEE 754 arithmetic.
const value = fc.oneof(
  fc.double({ min: -1e9, max: 1e9, noNaN: true }),
  fc.constantFrom(0, Number.NaN, Infinity, -Infinity, null)
);
const edgeRow = fc.record({
  src: endpoint,
  dst: endpoint,
  value,
  job: fc.constantFrom('', 'ring-a', 'ring-b'),
  hop: fc.constantFrom('', '1', '2', '10', 'x', '1.5'),
});
type DrawnRow = typeof edgeRow extends fc.Arbitrary<infer T> ? T : never;

const aggregation = fc.constantFrom<SpatialAggregation>('max', 'min', 'sum', 'mean');
const worst = fc.constantFrom<'high' | 'low'>('high', 'low');
const threshold = fc.oneof(fc.constant(undefined), fc.double({ min: -10, max: 10, noNaN: true }));

function buildModel(rows: DrawnRow[], over: Partial<FleetGridOptions>): FlowModel {
  const frame = toDataFrame({
    refId: 'E',
    fields: [
      { name: 'src_host', type: FieldType.string, values: rows.map((r) => r.src) },
      { name: 'dst_host', type: FieldType.string, values: rows.map((r) => r.dst) },
      { name: 'job', type: FieldType.string, values: rows.map((r) => r.job) },
      { name: 'hop', type: FieldType.string, values: rows.map((r) => r.hop) },
      { name: 'loss', type: FieldType.number, values: rows.map((r) => r.value) },
    ],
  });
  const options: FleetGridOptions = {
    levels,
    displayMode: 'single',
    showValues: true,
    missingColor: '#444',
    spatialAggregation: 'max',
    reduceCalc: 'lastNotNull',
    flowRefId: 'E',
    flowEndpoints: [{ level: 'host', source: 'src_host', destination: 'dst_host' }],
    flowOrderLabel: 'hop',
    flowPathLabel: 'job',
    ...over,
  };
  return buildFlowModel([frame], root, options, resolveFlowConfig(options)!, theme, 'utc');
}

const isKnown = (host: string) => KNOWN.includes(host);
const isFiniteValue = (v: number | null): v is number => v !== null && Number.isFinite(v);

function fold(values: number[], agg: SpatialAggregation): number {
  switch (agg) {
    case 'max':
      return values.reduce((a, b) => Math.max(a, b));
    case 'min':
      return values.reduce((a, b) => Math.min(a, b));
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

// The naive reference: ordered pair → the finite values of its rows.
function reference(rows: DrawnRow[]) {
  const pairs = new Map<string, number[]>();
  const counts = { missingLabel: 0, unmatched: 0, selfEdges: 0 };
  for (const r of rows) {
    if (r.src === '' || r.dst === '') {
      counts.missingLabel++;
    } else if (!isKnown(r.src) || !isKnown(r.dst)) {
      counts.unmatched++;
    } else if (r.src === r.dst) {
      counts.selfEdges++;
    } else {
      const key = `${nodeOf(r.src)}>${nodeOf(r.dst)}`;
      const values = pairs.get(key) ?? [];
      if (isFiniteValue(r.value)) {
        values.push(r.value);
      }
      pairs.set(key, values);
    }
  }
  return { pairs, counts };
}

const keyOf = (edge: FlowEdge) => `${edge.source}>${edge.destination}`;

describe('buildFlowModel (properties)', () => {
  it('puts every row into exactly one edge or one counted reason, and aggregates like the reference', () => {
    fc.assert(
      fc.property(fc.array(edgeRow, { maxLength: 40 }), aggregation, (rows, agg) => {
        const model = buildModel(rows, { spatialAggregation: agg });
        const { pairs, counts } = reference(rows);

        expect(model.stats).toMatchObject({ ...counts, ambiguous: 0, edgeCount: pairs.size });
        expect(model.stats.totalRows).toBe(rows.length);
        expect(model.stats.readRows).toBe(rows.length);
        expect(model.edges.map(keyOf).sort()).toEqual([...pairs.keys()].sort());
        let rowsInEdges = 0;
        for (const edge of model.edges) {
          const values = pairs.get(keyOf(edge))!;
          // Unknown stays unknown: an edge is null exactly when none of its rows has a finite value.
          expect(edge.value).toBe(values.length > 0 ? fold(values, agg) : null);
          rowsInEdges += edge.rowCount;
        }
        expect(rowsInEdges + counts.missingLabel + counts.unmatched + counts.selfEdges).toBe(rows.length);
      }),
      propertyParams()
    );
  });

  it('ranks worst first, applies the threshold strictly, and ignores the order of the rows', () => {
    fc.assert(
      fc.property(fc.array(edgeRow, { maxLength: 40 }), worst, threshold, (rows, direction, limit) => {
        const model = buildModel(rows, { flowWorst: direction, flowThreshold: limit });
        const all = buildModel(rows, { flowWorst: direction });
        const passes = (edge: FlowEdge) =>
          limit === undefined ||
          (edge.value !== null && (direction === 'high' ? edge.value > limit : edge.value < limit));

        expect(model.edges.map(keyOf).sort()).toEqual(all.edges.filter(passes).map(keyOf).sort());
        for (let i = 1; i < model.edges.length; i++) {
          const a = model.edges[i - 1].value;
          const b = model.edges[i].value;
          if (a === null) {
            expect(b).toBeNull(); // edges without a value come last
          } else if (b !== null) {
            expect(direction === 'high' ? a >= b : a <= b).toBe(true);
          }
        }
        const reversed = buildModel([...rows].reverse(), { flowWorst: direction, flowThreshold: limit });
        expect(reversed.edges.map(keyOf)).toEqual(model.edges.map(keyOf));
      }),
      propertyParams()
    );
  });

  it('focuses exactly the edges of the node and of the paths it is on, and summarizes them', () => {
    fc.assert(
      fc.property(fc.array(edgeRow, { maxLength: 40 }), fc.constantFrom(...KNOWN), (rows, host) => {
        const model = buildModel(rows, {});
        const node = nodeOf(host);
        const incident = model.edges.filter((edge) => edge.source === node || edge.destination === node);
        const paths = new Set(incident.flatMap((edge) => edge.hops.map((hop) => hop.path)));
        const expected = model.edges.filter(
          (edge) => incident.includes(edge) || edge.hops.some((hop) => paths.has(hop.path))
        );
        const focus = flowFocusEdges(model, [node]);
        const summary = summarizeFlowNode(model, node);

        if (incident.length === 0) {
          expect(focus).toBeNull();
          expect(summary).toBeNull();
          return;
        }
        // Same edges, in the model's worst-first order.
        expect(focus).toEqual(expected);
        expect(summary!.outCount + summary!.inCount).toBe(incident.length);
        expect(summary!.outCount).toBe(incident.filter((edge) => edge.source === node).length);
        expect(summary!.worst.edge).toBe(incident[0]);
        expect(summary!.hops).toHaveLength(incident.reduce((count, edge) => count + edge.hops.length, 0));
      }),
      propertyParams()
    );
  });

  it('reads hop numbers only from whole numbers and never invents a path', () => {
    fc.assert(
      fc.property(fc.array(edgeRow, { maxLength: 40 }), (rows) => {
        const model = buildModel(rows, {});
        const accepted = rows.filter((r) => isKnown(r.src) && isKnown(r.dst) && r.src !== r.dst);
        expect(model.stats.invalidOrder).toBe(accepted.filter((r) => r.hop === 'x' || r.hop === '1.5').length);
        for (const edge of model.edges) {
          const own = accepted.filter((r) => `${nodeOf(r.src)}>${nodeOf(r.dst)}` === keyOf(edge));
          for (const hop of edge.hops) {
            expect(
              own.some(
                (r) => r.job === hop.path && (hop.order === null ? !/^\d+$/.test(r.hop) : r.hop === String(hop.order))
              )
            ).toBe(true);
          }
        }
      }),
      propertyParams()
    );
  });
});
