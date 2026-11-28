import fc from 'fast-check';
import { FieldType, createTheme, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, FleetGridOptions, LevelDef, NormalizedRow, SpatialAggregation } from '../types';
import { buildHierarchy, pathKey } from './hierarchy';
import { attachCells } from './values';
import {
  FlowEdge,
  FlowModel,
  buildFlowModel,
  flowFocusEdges,
  resolveFlowConfig,
  selectWorstRows,
  shareFlowBound,
  summarizeFlowNode,
} from './edges';
import { countFrameRows, normalizeFrames } from './normalize';
import { propertyParams } from '../testing/property';

// Model-based check of the flow overlay's data stage: every edge-query row is either part of exactly
// one edge or counted under exactly one reason, an edge's value is the worst of the finite values of
// its ordered pair (never 0 for "unknown", and never the cells' spatial aggregation), and the ranking,
// the filter and the hover index agree with a naive reference.

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

// The worst of the values: the highest when higher is worse, the lowest when lower is worse.
const worstOf = (values: number[], direction: 'high' | 'low'): number =>
  values.reduce((a, b) => (direction === 'high' ? Math.max(a, b) : Math.min(a, b)));

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
      fc.property(fc.array(edgeRow, { maxLength: 40 }), aggregation, worst, (rows, agg, direction) => {
        // The cells' aggregation is drawn too: it must not change an edge.
        const model = buildModel(rows, { spatialAggregation: agg, flowWorst: direction });
        const { pairs, counts } = reference(rows);

        expect(model.stats).toMatchObject({ ...counts, ambiguous: 0, edgeCount: pairs.size });
        expect(model.stats.totalRows).toBe(rows.length);
        expect(model.stats.readRows).toBe(rows.length);
        expect(model.edges.map(keyOf).sort()).toEqual([...pairs.keys()].sort());
        let rowsInEdges = 0;
        for (const edge of model.edges) {
          const values = pairs.get(keyOf(edge))!;
          // Unknown stays unknown: an edge is null exactly when none of its rows has a finite value.
          expect(edge.value).toBe(values.length > 0 ? worstOf(values, direction) : null);
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

// The rows that are used of a result with more rows than the bound: for any frames, direction and
// bound, they are the worst rows by value, and the rows without a value get their share.
describe('selectWorstRows (properties)', () => {
  // Few distinct values, so that ties at the cut are common.
  const rowValue = fc.oneof(fc.constantFrom(0, 1, 2, 3, 5, 8), fc.constantFrom(null, Number.NaN));
  const tableFrame = fc.array(rowValue, { maxLength: 12 }).map((values) =>
    toDataFrame({
      refId: 'E',
      fields: [
        { name: 'src_host', type: FieldType.string, values: values.map((_, i) => `node-a${i}`) },
        { name: 'loss', type: FieldType.number, values },
      ],
    })
  );
  const seriesFrame = fc.array(rowValue, { minLength: 1, maxLength: 4 }).map((values) =>
    toDataFrame({
      refId: 'E',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000] },
        ...values.map((v, i) => ({
          name: 'Value',
          type: FieldType.number,
          values: [v],
          labels: { src_host: `node-b${i}` },
        })),
      ],
    })
  );
  const valuesOf = (frames: Array<ReturnType<typeof toDataFrame>>) =>
    normalizeFrames(frames, 'lastNotNull').map((row) => row.value);

  it('keeps the worst rows by value and the share of the rows without a value', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(tableFrame, seriesFrame), { maxLength: 6 }),
        worst,
        fc.integer({ min: 1, max: 12 }),
        (frames, direction, bound) => {
          const all = valuesOf(frames);
          fc.pre(all.length > bound);
          const kept = valuesOf(selectWorstRows(frames, 'lastNotNull', direction, countFrameRows(frames), bound));

          const valued = all.filter((v): v is number => v !== null);
          const share = shareFlowBound(valued.length, all.length - valued.length, bound);
          expect(kept).toHaveLength(bound);
          expect(kept.filter((v) => v === null)).toHaveLength(share.unknown);
          const worstFirst = [...valued].sort((a, b) => (direction === 'high' ? b - a : a - b));
          const keptValued = kept.filter((v): v is number => v !== null);
          expect([...keptValued].sort((a, b) => a - b)).toEqual(
            worstFirst.slice(0, share.valued).sort((a, b) => a - b)
          );
        }
      ),
      propertyParams()
    );
  });

  it('keeps the labels of the rows it keeps', () => {
    fc.assert(
      fc.property(fc.array(tableFrame, { minLength: 1, maxLength: 4 }), worst, (frames, direction) => {
        const all = normalizeFrames(frames, 'lastNotNull');
        fc.pre(all.length > 3);
        const kept = normalizeFrames(
          selectWorstRows(frames, 'lastNotNull', direction, countFrameRows(frames), 3),
          'lastNotNull'
        );
        // Every kept row is a row of the result, with its own label and value.
        for (const row of kept) {
          expect(all.some((r) => r.labels.src_host === row.labels.src_host && Object.is(r.value, row.value))).toBe(
            true
          );
        }
      }),
      propertyParams()
    );
  });
});
