import { DataFrame, FieldColorModeId, FieldType, ThresholdsMode, createTheme, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, FleetGridOptions, HierarchyNode, LevelDef, NormalizedRow } from '../types';
import { buildHierarchy, pathKey } from './hierarchy';
import { attachCells } from './values';
import {
  DEFAULT_FLOW_REST_ARCS,
  FlowConfig,
  FlowEdge,
  MAX_FLOW_ARCS,
  MAX_FLOW_ROWS,
  buildEndpointIndex,
  buildFlowModel,
  collectFlowEdges,
  flowBaseEdges,
  flowFocusEdges,
  flowRestShare,
  shareFlowBound,
  flowNodeKey,
  flowRefId,
  resolveFlowConfig,
  selectFlowEdges,
  summarizeFlowNode,
} from './edges';

const theme = createTheme();

const levels: LevelDef[] = [
  { ...DEFAULT_LEVEL, label: 'zone' },
  { ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' },
  { ...DEFAULT_LEVEL, label: 'gpu' },
];

// Two zones of two hosts with two GPUs each. node-a1 and node-b1 both extract to the key "1".
const cellRows: NormalizedRow[] = ['a', 'b'].flatMap((zone) =>
  [1, 2].flatMap((host) =>
    ['gpu0', 'gpu1'].map((gpu) => ({
      labels: { zone: `zone-${zone}`, host: `node-${zone}${host}`, gpu },
      value: 1,
      refId: 'A',
    }))
  )
);

function hierarchy(rows: NormalizedRow[] = cellRows, lv: LevelDef[] = levels): HierarchyNode {
  const { root } = buildHierarchy(rows, lv);
  attachCells(root, rows, lv, 'max');
  return root;
}

const hostMapping = { level: 'host', source: 'src_host', destination: 'dst_host' };

const config = (over: Partial<FlowConfig> = {}): FlowConfig => ({
  refId: 'E',
  endpoints: [hostMapping],
  incompleteEndpoints: 0,
  show: 'always',
  restArcs: 500,
  worst: 'high',
  threshold: undefined,
  orderLabel: '',
  pathLabel: '',
  ...over,
});

const options = (over: Partial<FleetGridOptions> = {}): FleetGridOptions => ({
  levels,
  displayMode: 'single',
  showValues: true,
  missingColor: '#444',
  spatialAggregation: 'max',
  reduceCalc: 'lastNotNull',
  flowRefId: 'E',
  flowEndpoints: [hostMapping],
  ...over,
});

const edgeRow = (
  src: string,
  dst: string,
  value: number | null,
  extra: Record<string, string> = {}
): NormalizedRow => ({
  labels: { src_host: src, dst_host: dst, ...extra },
  value,
  refId: 'E',
});

const hostKey = (zone: string, host: string) => pathKey([zone, host]);
const A1 = hostKey('zone-a', '1');
const A2 = hostKey('zone-a', '2');
const B1 = hostKey('zone-b', '1');
const B2 = hostKey('zone-b', '2');

function collect(rows: NormalizedRow[], cfg: FlowConfig = config()) {
  return collectFlowEdges(rows, buildEndpointIndex(hierarchy(), levels, cfg.endpoints), cfg);
}

const pairs = (edges: FlowEdge[]) => edges.map((edge) => `${edge.source}>${edge.destination}=${edge.value}`);

// An edge-query table frame, as Prometheus "instant + format: table" or a CSV returns it.
function edgeTable(columns: Record<string, Array<string | number | null>>, refId = 'E'): DataFrame {
  return toDataFrame({
    refId,
    fields: Object.entries(columns).map(([name, values]) => ({
      name,
      type: values.some((v) => typeof v === 'number') ? FieldType.number : FieldType.string,
      values,
    })),
  });
}

function model(frames: DataFrame[], over: Partial<FleetGridOptions> = {}) {
  const opts = options(over);
  return buildFlowModel(frames, hierarchy(), opts, resolveFlowConfig(opts)!, theme, 'utc');
}

describe('resolveFlowConfig', () => {
  it('is off unless an edge query is named', () => {
    expect(resolveFlowConfig(options({ flowRefId: undefined }))).toBeNull();
    expect(resolveFlowConfig(options({ flowRefId: '' }))).toBeNull();
    expect(resolveFlowConfig(options({ flowRefId: '  ' }))).toBeNull();
    expect(flowRefId({ flowRefId: 'E' })).toBe('E');
  });

  it('normalizes missing and malformed options to the defaults', () => {
    const resolved = resolveFlowConfig(
      options({
        flowShow: 'sometimes' as never,
        flowWorst: undefined,
        flowThreshold: Number.NaN,
        flowEndpoints: [hostMapping, { level: 'host', source: '', destination: 'dst_host' }, null as never],
        flowOrderLabel: undefined,
        flowPathLabel: ' ',
      })
    );
    // The two unusable mappings are counted, so the model can refuse to draw with only the usable one.
    expect(resolved).toEqual(config({ incompleteEndpoints: 2, restArcs: DEFAULT_FLOW_REST_ARCS }));
  });

  it('limits the arcs at rest to 1 to 500 whole arcs', () => {
    const restArcs = (value: unknown) => resolveFlowConfig(options({ flowRestArcs: value as number }))!.restArcs;
    expect(DEFAULT_FLOW_REST_ARCS).toBe(100);
    expect([restArcs(undefined), restArcs(Number.NaN), restArcs('40'), restArcs(null)]).toEqual([100, 100, 100, 100]);
    expect([restArcs(40), restArcs(40.6), restArcs(0), restArcs(-5), restArcs(501)]).toEqual([40, 41, 1, 1, 500]);
  });

  it('takes the names without the spaces around them, so "E " names query E', () => {
    expect(flowRefId({ flowRefId: ' E ' })).toBe('E');
    const resolved = resolveFlowConfig(
      options({
        flowRefId: 'E ',
        flowEndpoints: [{ level: 'host', source: ' src_host', destination: 'dst_host ' }],
        flowOrderLabel: ' hop ',
        flowPathLabel: 'job ',
      })
    )!;
    expect(resolved.refId).toBe('E');
    expect(resolved.endpoints).toEqual([hostMapping]);
    expect([resolved.orderLabel, resolved.pathLabel]).toEqual(['hop', 'job']);
  });

  it('keeps the configured values', () => {
    const resolved = resolveFlowConfig(
      options({ flowShow: 'hover', flowWorst: 'low', flowThreshold: 0, flowOrderLabel: 'hop', flowPathLabel: 'job' })
    );
    expect(resolved).toMatchObject({ show: 'hover', worst: 'low', threshold: 0, orderLabel: 'hop', pathLabel: 'job' });
  });
});

describe('buildEndpointIndex', () => {
  it('resolves a host mapping to the host group when the cells are GPUs', () => {
    const index = buildEndpointIndex(hierarchy(), levels, [hostMapping]);
    expect(index.depth).toBe(2);
    expect(index.byValues.get(JSON.stringify(['node-a1']))).toBe(A1);
    // The raw label value is compared: node-a1 and node-b1 share the extracted key "1" but stay apart.
    expect(index.byValues.get(JSON.stringify(['node-b1']))).toBe(B1);
    expect(index.paths.get(B1)).toEqual(['zone-b', '1']);
  });

  it('resolves to the cell when every level down to the leaf is mapped', () => {
    const index = buildEndpointIndex(hierarchy(), levels, [
      hostMapping,
      { level: 'gpu', source: 'src_gpu', destination: 'dst_gpu' },
    ]);
    expect(index.depth).toBe(3);
    expect(index.byValues.get(JSON.stringify(['node-a2', 'gpu1']))).toBe(pathKey(['zone-a', '2', 'gpu1']));
  });

  it('marks values that two nodes carry as ambiguous instead of picking one', () => {
    // gpu0 exists under every host, so mapping the gpu label alone cannot name one cell.
    const index = buildEndpointIndex(hierarchy(), levels, [{ level: 'gpu', source: 's', destination: 'd' }]);
    expect(index.byValues.get(JSON.stringify(['gpu0']))).toBeNull();
  });

  it('lets several raw values that extract to one key resolve to the same node', () => {
    const rows: NormalizedRow[] = [
      { labels: { zone: 'zone-a', host: 'node-a017', gpu: 'gpu0' }, value: 1, refId: 'A' },
      { labels: { zone: 'zone-a', host: 'node-b017', gpu: 'gpu0' }, value: 1, refId: 'A' },
    ];
    const index = buildEndpointIndex(hierarchy(rows), levels, [hostMapping]);
    const node = pathKey(['zone-a', '017']);
    expect(index.byValues.get(JSON.stringify(['node-a017']))).toBe(node);
    expect(index.byValues.get(JSON.stringify(['node-b017']))).toBe(node);
  });
});

describe('collectFlowEdges', () => {
  it('keeps the two directions of a pair as two edges', () => {
    const { edges } = collect([edgeRow('node-a1', 'node-b1', 1), edgeRow('node-b1', 'node-a1', 2)]);
    expect(pairs(edges).sort()).toEqual([`${A1}>${B1}=1`, `${B1}>${A1}=2`].sort());
  });

  it('gives an edge the worst value of the rows of its ordered pair', () => {
    const rows = [edgeRow('node-a1', 'node-a2', 1), edgeRow('node-a1', 'node-a2', 3), edgeRow('node-a1', 'node-a2', 2)];
    // Higher is worse: the highest row. Lower is worse: the lowest row.
    expect(collect(rows).edges).toEqual([{ source: A1, destination: A2, value: 3, rowCount: 3, hops: [] }]);
    expect(collect(rows, config({ worst: 'low' })).edges[0].value).toBe(1);
  });

  it('keeps an edge whose rows have no value as unknown, never as 0', () => {
    const { edges, stats } = collect([
      edgeRow('node-a1', 'node-a2', null),
      edgeRow('node-a1', 'node-b1', null),
      edgeRow('node-a1', 'node-b1', 5),
    ]);
    expect(pairs(edges)).toEqual([`${A1}>${A2}=null`, `${A1}>${B1}=5`]);
    expect(stats).toMatchObject({ edgeCount: 2, noValue: 1 });
  });

  it('counts a self-edge and draws no arc for it', () => {
    const { edges, stats, nodes } = collect([edgeRow('node-a1', 'node-a1', 4)]);
    expect(edges).toEqual([]);
    expect(stats.selfEdges).toBe(1);
    expect(nodes.size).toBe(0);
  });

  it('keeps the worst value among the rows it cannot draw, so a degraded row is not lost with them', () => {
    const rows = [
      edgeRow('node-a1', 'node-a1', 4), // within one host
      edgeRow('node-a2', 'node-a2', 9),
      edgeRow('node-b1', 'node-b1', null),
      edgeRow('node-a1', 'node-x9', 7), // matches no cell
      edgeRow('node-x8', 'node-a1', 3),
      edgeRow('', 'node-a1', 30), // no endpoint label
      edgeRow('node-a1', 'node-a2', 1),
    ];
    expect(collect(rows).stats).toMatchObject({ selfEdges: 3, selfWorst: 9, excludedWorst: 30 });
    // The worse end follows the option.
    expect(collect(rows, config({ worst: 'low' })).stats).toMatchObject({ selfWorst: 4, excludedWorst: 3 });
    // Rows without a value add no number: unknown is not 0.
    expect(collect([edgeRow('node-a1', 'node-a1', null), edgeRow('node-a1', 'node-x9', null)]).stats).toMatchObject({
      selfEdges: 1,
      selfWorst: null,
      unmatched: 1,
      excludedWorst: null,
    });
    expect(collect([edgeRow('node-a1', 'node-a2', 1)]).stats).toMatchObject({ selfWorst: null, excludedWorst: null });
  });

  it('counts rows whose endpoint matches nothing and keeps a few examples', () => {
    const { edges, stats } = collect([
      edgeRow('node-a1', 'node-x9', 1),
      edgeRow('node-x9', 'node-a1', 1),
      edgeRow('node-x7', 'node-x8', 1),
      edgeRow('node-x6', 'node-x5', 1),
      edgeRow('node-a1', 'node-a2', 1),
    ]);
    expect(edges).toHaveLength(1);
    expect(stats.unmatched).toBe(4);
    expect(stats.examples).toEqual(['dst_host=node-x9', 'src_host=node-x9', 'src_host=node-x7']);
  });

  it('takes its examples only from rows it counted as unmatched', () => {
    // The source matches nothing, but the row is counted for its missing destination label.
    const { stats } = collect([{ labels: { src_host: 'node-x9' }, value: 1, refId: 'E' }]);
    expect(stats).toMatchObject({ missingLabel: 1, unmatched: 0, examples: [] });
  });

  it('counts each excluded row once, by its first reason', () => {
    const cfg = config({ endpoints: [{ level: 'gpu', source: 'src_gpu', destination: 'dst_gpu' }] });
    const { stats } = collect(
      [
        { labels: { src_gpu: 'gpu0', dst_gpu: 'gpu9' }, value: 1, refId: 'E' }, // ambiguous and unmatched
        { labels: { src_gpu: 'gpu0' }, value: 1, refId: 'E' }, // ambiguous and a missing label
        { labels: { src_gpu: 'gpu0', dst_gpu: '' }, value: 1, refId: 'E' }, // an empty label is no label
        { labels: { src_gpu: 'gpu0', dst_gpu: 'gpu1' }, value: 1, refId: 'E' }, // ambiguous twice
      ],
      cfg
    );
    expect(stats).toMatchObject({ missingLabel: 2, unmatched: 1, ambiguous: 1, edgeCount: 0 });
  });

  it('reads only the labels a row has, whatever the configured label names are', () => {
    // "constructor" and "toString" exist on every object; they are not labels of the row.
    const cfg = config({
      endpoints: [{ level: 'host', source: 'constructor', destination: 'dst_host' }],
      orderLabel: 'toString',
      pathLabel: 'valueOf',
    });
    const { stats } = collect([{ labels: { dst_host: 'node-a2' }, value: 1, refId: 'E' }], cfg);
    expect(stats).toMatchObject({ missingLabel: 1, unmatched: 0, invalidOrder: 0 });
    const ok = collect([edgeRow('node-a1', 'node-a2', 1)], config({ orderLabel: 'toString', pathLabel: 'valueOf' }));
    expect(ok.stats.invalidOrder).toBe(0);
    expect(ok.edges[0].hops).toEqual([]);
  });

  it('labels a node with the raw endpoint value of the edge query', () => {
    const { nodes } = collect([edgeRow('node-a1', 'node-b2', 1)]);
    expect(nodes.get(A1)).toEqual({ key: A1, path: ['zone-a', '1'], label: 'node-a1' });
    expect(nodes.get(B2)?.label).toBe('node-b2');
  });

  it('reads hop numbers and path names, and sorts the hops of an edge', () => {
    const cfg = config({ orderLabel: 'hop', pathLabel: 'job' });
    const { edges, stats } = collect(
      [
        edgeRow('node-a1', 'node-a2', 1, { hop: '7', job: 'ring-b' }),
        edgeRow('node-a1', 'node-a2', 1, { hop: '002', job: 'ring-a' }),
        edgeRow('node-a1', 'node-a2', 1, { hop: '2', job: 'ring-a' }), // the same hop again
        edgeRow('node-a1', 'node-a2', 1, { job: 'tree-a' }), // a path without hop numbers
        edgeRow('node-a2', 'node-b1', 1), // an edge on no path
      ],
      cfg
    );
    expect(stats.invalidOrder).toBe(0);
    expect(edges[0].hops).toEqual([
      { path: 'ring-a', order: 2 },
      { path: 'ring-b', order: 7 },
      { path: 'tree-a', order: null },
    ]);
    expect(edges[1].hops).toEqual([]);
  });

  it('keeps an edge whose hop number is not a whole number and counts the row', () => {
    const cfg = config({ orderLabel: 'hop' });
    const { edges, stats } = collect(
      [
        edgeRow('node-a1', 'node-a2', 1, { hop: '1.5' }),
        edgeRow('node-a2', 'node-b1', 1, { hop: '-1' }),
        edgeRow('node-b1', 'node-b2', 1, { hop: '3' }),
      ],
      cfg
    );
    expect(stats.invalidOrder).toBe(2);
    expect(edges.map((edge) => edge.hops)).toEqual([[], [], [{ path: '', order: 3 }]]);
  });
});

describe('selectFlowEdges', () => {
  const edge = (source: string, destination: string, value: number | null): FlowEdge => ({
    source,
    destination,
    value,
    rowCount: 1,
    hops: [],
  });
  const edges = [edge('b', 'c', 1), edge('a', 'c', null), edge('a', 'b', 3), edge('c', 'a', 1), edge('a', 'd', 0)];

  it('orders worst first, with edges without a value last', () => {
    expect(pairs(selectFlowEdges(edges, 'high', undefined))).toEqual(['a>b=3', 'b>c=1', 'c>a=1', 'a>d=0', 'a>c=null']);
    expect(pairs(selectFlowEdges(edges, 'low', undefined))).toEqual(['a>d=0', 'b>c=1', 'c>a=1', 'a>b=3', 'a>c=null']);
  });

  it('does not depend on the order of the query result', () => {
    const expected = pairs(selectFlowEdges(edges, 'high', undefined));
    expect(pairs(selectFlowEdges([...edges].reverse(), 'high', undefined))).toEqual(expected);
  });

  it('keeps only the edges strictly worse than the threshold', () => {
    // Higher is worse: "loss > 0" leaves out the healthy edge and the edge without a value.
    expect(pairs(selectFlowEdges(edges, 'high', 0))).toEqual(['a>b=3', 'b>c=1', 'c>a=1']);
    expect(pairs(selectFlowEdges(edges, 'high', 1))).toEqual(['a>b=3']);
    // Lower is worse: "rate < 1" keeps only the edge below the objective.
    expect(pairs(selectFlowEdges(edges, 'low', 1))).toEqual(['a>d=0']);
    expect(selectFlowEdges(edges, 'low', 0)).toEqual([]);
  });

  it('does not change its input', () => {
    const before = pairs(edges);
    selectFlowEdges(edges, 'low', 2);
    expect(pairs(edges)).toEqual(before);
  });
});

describe('buildFlowModel', () => {
  it('does not let healthy rows of a pair hide a degraded one, whatever the cells are aggregated with', () => {
    // Three rows of one host pair, for example three RNIC pairs: two healthy (100) and one degraded (1).
    const frame = edgeTable({
      src_host: ['node-a1', 'node-a1', 'node-a1'],
      dst_host: ['node-a2', 'node-a2', 'node-a2'],
      rate: [100, 100, 1],
    });
    for (const spatialAggregation of ['max', 'mean', 'min', 'sum'] as const) {
      const m = model([frame], { flowWorst: 'low', flowThreshold: 50, spatialAggregation });
      expect(pairs(m.edges)).toEqual([`${A1}>${A2}=1`]);
    }
  });

  it('does not dilute one lossy row among healthy ones below the filter', () => {
    const frame = edgeTable({
      src_host: Array(8).fill('node-a1'),
      dst_host: Array(8).fill('node-a2'),
      loss: [5, 0, 0, 0, 0, 0, 0, 0],
    });
    for (const spatialAggregation of ['max', 'mean', 'min', 'sum'] as const) {
      const m = model([frame], { flowThreshold: 1, spatialAggregation });
      expect(pairs(m.edges)).toEqual([`${A1}>${A2}=5`]);
    }
  });

  it('reads a table frame and takes a numeric hop column as a label, not as the value', () => {
    const frame = edgeTable({
      src_host: ['node-a1', 'node-a2'],
      dst_host: ['node-a2', 'node-b1'],
      hop: [1, 2],
      loss: [0.5, 0],
    });
    const m = model([frame], { flowOrderLabel: 'hop' });
    expect(pairs(m.edges)).toEqual([`${A1}>${A2}=0.5`, `${A2}>${B1}=0`]);
    expect(m.edges.map((edge) => edge.hops)).toEqual([[{ path: '', order: 1 }], [{ path: '', order: 2 }]]);
    expect(m).toMatchObject({ depth: 2, levelLabel: 'host', groupLevel: true, warnings: [] });
    expect(m.stats).toMatchObject({ totalRows: 2, readRows: 2, edgeCount: 2 });
  });

  it('treats an empty label cell as no label, not as the text "null"', () => {
    const frame = edgeTable({
      src_host: ['node-a1', 'node-a2'],
      dst_host: ['node-a2', 'node-b1'],
      job: ['ring-a', null],
      hop: [1, null],
      loss: [1, 2],
    });
    const m = model([frame], { flowOrderLabel: 'hop', flowPathLabel: 'job' });
    expect(m.edges.find((edge) => edge.source === A2)?.hops).toEqual([]);
    expect([...m.byPath.keys()]).toEqual(['ring-a']);
    expect(m.stats.invalidOrder).toBe(0);
  });

  it('reduces a range series with the panel calculation', () => {
    const series = toDataFrame({
      refId: 'E',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000, 2000, 3000] },
        {
          name: 'Value',
          type: FieldType.number,
          values: [1, 2, 6],
          labels: { src_host: 'node-a1', dst_host: 'node-b2' },
        },
      ],
    });
    expect(model([series]).edges[0].value).toBe(6);
    expect(model([series], { reduceCalc: 'mean' }).edges[0].value).toBe(3);
  });

  it('keeps an edge whose value is not finite as unknown', () => {
    const frame = edgeTable({
      src_host: ['node-a1', 'node-a2'],
      dst_host: ['node-a2', 'node-b1'],
      loss: [Number.NaN, 2],
    });
    const m = model([frame]);
    expect(pairs(m.edges)).toEqual([`${A2}>${B1}=2`, `${A1}>${A2}=null`]);
    expect(m.stats.noValue).toBe(1);
    // With a filter the unknown edge cannot be compared and is not drawn.
    expect(pairs(model([frame], { flowThreshold: 0 }).edges)).toEqual([`${A2}>${B1}=2`]);
  });

  it('colors with the standard field config of the edge query', () => {
    const frame = edgeTable({ src_host: ['node-a1'], dst_host: ['node-a2'], loss: [5] });
    frame.fields[2].config = {
      unit: 'percent',
      color: { mode: 'thresholds' },
      thresholds: {
        mode: ThresholdsMode.Absolute,
        steps: [
          { value: -Infinity, color: '#00ff00' },
          { value: 1, color: '#ff0000' },
        ],
      },
    };
    const info = model([frame]).metricInfo!;
    expect(info.processor(5).color).toBe('#ff0000');
    expect(info.processor(0.5).color).toBe('#00ff00');
    expect(info.processor(5).suffix).toBe('%');
  });

  describe('automatic color range', () => {
    // The continuous green-yellow-red scheme of the README's quick start, no Min/Max, no override.
    const colored = (columns: Record<string, Array<string | number | null>>, config = {}) => {
      const frame = edgeTable(columns);
      const value = frame.fields.find((field) => field.type === FieldType.number)!;
      value.config = { color: { mode: FieldColorModeId.ContinuousGrYlRd }, ...config };
      return frame;
    };
    const colorOf = (m: ReturnType<typeof model>, value: number) => m.metricInfo!.processor(value).color;

    it('does not change with the filter: a degraded edge keeps its color when the healthy ones are filtered out', () => {
      const frame = colored({
        src_host: ['node-a1', 'node-a2', 'node-b1'],
        dst_host: ['node-a2', 'node-b1', 'node-b2'],
        loss: [0, 5, 7],
      });
      const unfiltered = model([frame]);
      const filtered = model([frame], { flowThreshold: 1 });
      expect(pairs(filtered.edges)).toEqual([`${B1}>${B2}=7`, `${A2}>${B1}=5`]);
      expect([filtered.metricInfo!.effectiveMin, filtered.metricInfo!.effectiveMax]).toEqual([0, 7]);
      for (const value of [5, 7]) {
        expect(colorOf(filtered, value)).toBe(colorOf(unfiltered, value));
      }
      // The worst edge has the color of the high end, not of the low end.
      expect(colorOf(filtered, 7)).toBe(colorOf(filtered, filtered.metricInfo!.effectiveMax));
      expect(colorOf(filtered, 7)).not.toBe(colorOf(filtered, filtered.metricInfo!.effectiveMin));
    });

    it('starts at 0 when higher is worse, so a query that returns only degraded pairs does not color one healthy', () => {
      // The edge query filters in the data source (`> 0`): the only row is a degraded pair.
      const m = model([colored({ src_host: ['node-a1'], dst_host: ['node-a2'], loss: [7] })]);
      expect([m.metricInfo!.effectiveMin, m.metricInfo!.effectiveMax]).toEqual([0, 7]);
      expect(colorOf(m, 7)).not.toBe(colorOf(m, 0));
      // Values below 0 keep their own minimum.
      const negative = model([
        colored({ src_host: ['node-a1', 'node-a2'], dst_host: ['node-a2', 'node-b1'], loss: [-3, 7] }),
      ]);
      expect(negative.metricInfo!.effectiveMin).toBe(-3);
    });

    it('includes the threshold, the boundary between drawn and not drawn', () => {
      const frame = colored({ src_host: ['node-a1'], dst_host: ['node-a2'], rate: [1] });
      const low = model([frame], { flowWorst: 'low', flowThreshold: 50 });
      expect([low.metricInfo!.effectiveMin, low.metricInfo!.effectiveMax]).toEqual([1, 50]);
      // Lower is worse has no natural healthy end: without a threshold the range is the data's own.
      const open = model(
        [colored({ src_host: ['node-a1', 'node-a2'], dst_host: ['node-a2', 'node-b1'], rate: [20, 90] })],
        {
          flowWorst: 'low',
        }
      );
      expect([open.metricInfo!.effectiveMin, open.metricInfo!.effectiveMax]).toEqual([20, 90]);
    });

    it('leaves an endpoint that the field config sets alone', () => {
      // Min and Max of the standard options, or of an override "Fields returned by query": Grafana
      // applies both to the field config before the panel sees the frame.
      const frame = colored({ src_host: ['node-a1'], dst_host: ['node-a2'], loss: [7] }, { min: 2, max: 100 });
      const m = model([frame], { flowThreshold: 1 });
      expect([m.metricInfo!.effectiveMin, m.metricInfo!.effectiveMax]).toEqual([2, 100]);
      // Each end on its own: the other end stays automatic (0 when higher is worse; the data's maximum).
      const columns = { src_host: ['node-a1'], dst_host: ['node-a2'], loss: [7] };
      const onlyMax = model([colored(columns, { max: 100 })]);
      expect([onlyMax.metricInfo!.effectiveMin, onlyMax.metricInfo!.effectiveMax]).toEqual([0, 100]);
      const onlyMin = model([colored(columns, { min: 5 })]);
      expect([onlyMin.metricInfo!.effectiveMin, onlyMin.metricInfo!.effectiveMax]).toEqual([5, 7]);
    });
  });

  it('does not warn when the edge query ran and returned no rows: nothing is degraded', () => {
    // A query that filters in the data source ("> 0") returns nothing for a healthy fabric: an empty
    // frame, or no frame at all while the request still lists the query.
    const opts = options();
    const cfg = resolveFlowConfig(opts)!;
    const emptyFrame = model([edgeTable({ src_host: [], dst_host: [], loss: [] })]);
    const noFrame = buildFlowModel([], hierarchy(), opts, cfg, theme, 'utc', 'found');
    for (const m of [emptyFrame, noFrame]) {
      expect(m.edges).toEqual([]);
      expect(m.warnings).toEqual([]);
      expect(m.error).toBeNull();
    }
  });

  it('says that no query has the refId, which is not the same as a query without rows', () => {
    const opts = options({ flowRefId: 'Z' });
    const missing = buildFlowModel([], hierarchy(), opts, resolveFlowConfig(opts)!, theme, 'utc', 'missing');
    expect(missing.warnings).toEqual([
      'Flow overlay: no query with the refId "Z" ran (it does not exist or is hidden)',
    ]);
    expect(missing.error).toBe('no query "Z"');
    // Without a frame and without a request to look the query up in, the model cannot tell and says so.
    const unknown = model([]);
    expect(unknown.warnings).toEqual(['Flow overlay: query "E" returned no data']);
    expect(unknown.error).toBe('no data for query "E"');
  });

  it('gives the reason in a few words when the configuration cannot be used', () => {
    const frame = edgeTable({ src_host: ['node-a1'], dst_host: ['node-a2'], loss: [5] });
    expect(model([frame], { flowEndpoints: [] }).error).toBe('no endpoint mapping');
    expect(model([frame], { flowEndpoints: [{ level: 'host', source: 'src_host', destination: '' }] }).error).toBe(
      'endpoint mapping incomplete'
    );
    expect(
      model([frame], { flowEndpoints: [{ level: 'rack', source: 'src_host', destination: 'dst_host' }] }).error
    ).toBe('endpoint mapping "rack" is not a hierarchy label');
    expect(model([frame]).error).toBeNull();
  });

  it('warns instead of guessing when no endpoint mapping can be used', () => {
    const frame = edgeTable({ src_host: ['node-a1'], dst_host: ['node-a2'], loss: [5] });
    expect(model([frame], { flowEndpoints: [] }).warnings).toEqual([
      'Flow overlay: map at least one hierarchy label to a source and a destination label of the edge query',
    ]);
    const incomplete =
      'Flow overlay: every endpoint mapping needs a hierarchy label, a source label and a destination label';
    expect(
      model([frame], { flowEndpoints: [{ level: 'host', source: 'src_host', destination: '' }] }).warnings
    ).toEqual([incomplete]);
    // A half-filled second mapping is not skipped: it would move the edges to another level than asked for.
    const halfFilled = model([frame], {
      flowEndpoints: [hostMapping, { level: 'gpu', source: 'src_gpu', destination: '' }],
    });
    expect(halfFilled.warnings).toEqual([incomplete]);
    expect(halfFilled.edges).toEqual([]);
    const unknown = model([frame], { flowEndpoints: [{ level: 'rack', source: 's', destination: 'd' }] });
    expect(unknown.warnings).toEqual(['Flow overlay: endpoint mapping "rack" is not a hierarchy label']);
    expect(unknown.edges).toEqual([]);
  });

  it('reports the rows it left out', () => {
    const frame = edgeTable({
      src_host: ['node-a1', 'node-a1', 'node-a1', ''],
      dst_host: ['node-a2', 'node-x9', 'node-a1', 'node-a2'],
      loss: [1, 1, 1, 1],
    });
    const m = model([frame]);
    expect(m.warnings).toEqual([
      'Flow overlay: 2/4 edge rows were left out (1 without an endpoint label, 1 with an endpoint that matches no cell or group; for example dst_host=node-x9)',
    ]);
    expect(m.stats).toMatchObject({ selfEdges: 1, edgeCount: 1 });
  });

  it('reports hop numbers it cannot read', () => {
    const frame = edgeTable({ src_host: ['node-a1'], dst_host: ['node-a2'], hop: ['first'], loss: [1] });
    expect(model([frame], { flowOrderLabel: 'hop' }).warnings).toEqual([
      'Flow overlay: 1 edge rows have a "hop" value that is not a whole number',
    ]);
  });

  describe('a result with more than MAX_FLOW_ROWS rows', () => {
    const extra = 5;
    const count = MAX_FLOW_ROWS + extra;
    const many = <T>(make: (i: number) => T) => Array.from({ length: count }, (_, i) => make(i));
    const used = (rows: number) =>
      `Flow overlay: query "E" returned ${count} rows; the worst ${rows} are used. Narrow the query (for example with topk)`;

    it('uses the worst rows, wherever they are in the result', () => {
      // Every row is healthy (0.1) but the last one, the only row to node-b1, which is degraded (99).
      const frame = edgeTable({
        src_host: many(() => 'node-a1'),
        dst_host: many((i) => (i === count - 1 ? 'node-b1' : 'node-a2')),
        loss: many((i) => (i === count - 1 ? 99 : 0.1)),
      });
      const m = model([frame]);
      expect(m.stats).toMatchObject({ totalRows: count, readRows: MAX_FLOW_ROWS });
      expect(pairs(m.edges)).toEqual([`${A1}>${B1}=99`, `${A1}>${A2}=0.1`]);
      expect(flowBaseEdges(m)[0].value).toBe(99);
      expect(m.warnings).toEqual([used(MAX_FLOW_ROWS)]);
    });

    it('leaves out the least bad rows, in the direction that is worse', () => {
      // Loss 0, 1, 2, ...: the five rows to node-b1 are the first ones, with the lowest values.
      const frame = edgeTable({
        src_host: many(() => 'node-a1'),
        dst_host: many((i) => (i < extra ? 'node-b1' : 'node-a2')),
        loss: many((i) => i),
      });
      // Higher is worse: the five lowest rows are left out, and with them the edge to node-b1.
      expect(pairs(model([frame]).edges)).toEqual([`${A1}>${A2}=${count - 1}`]);
      // Lower is worse: the five highest rows are left out; the lowest rows stay.
      expect(pairs(model([frame], { flowWorst: 'low' }).edges)).toEqual([`${A1}>${B1}=0`, `${A1}>${A2}=${extra}`]);
    });

    it('does not leave out the rows without a value first', () => {
      // The first ten rows, to node-b1, have no value; every other row is healthy.
      const frame = edgeTable({
        src_host: many(() => 'node-a1'),
        dst_host: many((i) => (i < 10 ? 'node-b1' : 'node-a2')),
        loss: many((i) => (i < 10 ? null : 0)),
      });
      const m = model([frame]);
      expect(m.stats.readRows).toBe(MAX_FLOW_ROWS);
      expect(pairs(m.edges)).toEqual([`${A1}>${A2}=0`, `${A1}>${B1}=null`]);
      expect(m.edges[1].rowCount).toBe(10);
    });

    it('ranks time series by their reduced value', () => {
      // One frame per series, as a data source returns them; the last series is the degraded one.
      const frames = many((i) =>
        toDataFrame({
          refId: 'E',
          fields: [
            { name: 'Time', type: FieldType.time, values: [1000, 2000] },
            {
              name: 'Value',
              type: FieldType.number,
              values: i === count - 1 ? [0, 99] : [50, 0.1],
              labels: { src_host: 'node-a1', dst_host: i === count - 1 ? 'node-b1' : 'node-a2' },
            },
          ],
        })
      );
      expect(pairs(model(frames).edges)).toEqual([`${A1}>${B1}=99`, `${A1}>${A2}=0.1`]);
      // With another calculation the same series are ranked by another value.
      expect(pairs(model(frames, { reduceCalc: 'max' }).edges)).toEqual([`${A1}>${B1}=99`, `${A1}>${A2}=50`]);
    });

    it('keeps the labels of the rows it uses, including a numeric hop column', () => {
      const frame = edgeTable({
        src_host: many(() => 'node-a1'),
        dst_host: many((i) => (i === count - 1 ? 'node-b1' : 'node-a2')),
        hop: many((i) => i),
        loss: many((i) => (i === count - 1 ? 99 : 0.1)),
      });
      const m = model([frame], { flowOrderLabel: 'hop' });
      expect(m.edges[0]).toMatchObject({ destination: B1, value: 99, hops: [{ path: '', order: count - 1 }] });
    });
  });
});

// A fleet of `hosts` hosts in one zone, and a model with one edge from every host to each of its next
// `fanOut` hosts.
function meshModel(hosts: number, fanOut: number, over: Partial<FleetGridOptions> = {}) {
  const lv: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'host' }];
  const rows: NormalizedRow[] = Array.from({ length: hosts }, (_, i) => ({
    labels: { host: `node-a${i}` },
    value: 1,
    refId: 'A',
  }));
  const src: string[] = [];
  const dst: string[] = [];
  const loss: number[] = [];
  for (let i = 0; i < hosts; i++) {
    for (let k = 1; k <= fanOut; k++) {
      src.push(`node-a${i}`);
      dst.push(`node-a${(i + k) % hosts}`);
      loss.push((i * 31 + k * 7) % 1000);
    }
  }
  const opts = options({ levels: lv, ...over });
  const frame = edgeTable({ src_host: src, dst_host: dst, loss });
  return buildFlowModel([frame], hierarchy(rows, lv), opts, resolveFlowConfig(opts)!, theme, 'utc');
}

describe('shareFlowBound', () => {
  it('draws everything that fits', () => {
    expect(shareFlowBound(300, 200, 500)).toEqual({ valued: 300, unknown: 200 });
    expect(shareFlowBound(0, 0, 500)).toEqual({ valued: 0, unknown: 0 });
  });

  it('does not cut the edges without a value first', () => {
    // 600 healthy edges and 20 whose probe returned nothing: all 20 are drawn.
    expect(shareFlowBound(600, 20, 500)).toEqual({ valued: 480, unknown: 20 });
  });

  it('keeps at least half of the bound for the edges with a value, when they need it', () => {
    expect(shareFlowBound(600, 600, 500)).toEqual({ valued: 250, unknown: 250 });
    expect(shareFlowBound(100, 600, 500)).toEqual({ valued: 100, unknown: 400 });
    expect(shareFlowBound(0, 600, 500)).toEqual({ valued: 0, unknown: 500 });
    expect(shareFlowBound(600, 0, 501)).toEqual({ valued: 501, unknown: 0 });
  });
});

describe('flowBaseEdges', () => {
  it('draws edges without a value even when the bound cuts healthy ones', () => {
    // 620 distinct pairs: 600 healthy (0) and 20 whose probe returned nothing.
    const names = Array.from({ length: 40 }, (_, i) => `node-a${i}`);
    const lv: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'host' }];
    const rows: NormalizedRow[] = names.map((host) => ({ labels: { host }, value: 1, refId: 'A' }));
    const src: string[] = [];
    const dst: string[] = [];
    for (let i = 0; i < names.length && src.length < 620; i++) {
      for (let j = 0; j < names.length && src.length < 620; j++) {
        if (i !== j) {
          src.push(names[i]);
          dst.push(names[j]);
        }
      }
    }
    const loss = src.map((_, i) => (i >= 600 ? null : 0));
    const opts = options({ levels: lv, flowRestArcs: 500 });
    const m = buildFlowModel(
      [edgeTable({ src_host: src, dst_host: dst, loss })],
      hierarchy(rows, lv),
      opts,
      resolveFlowConfig(opts)!,
      theme,
      'utc'
    );
    expect([m.edges.length, m.valuedCount]).toEqual([620, 600]);
    const base = flowBaseEdges(m);
    expect(base).toHaveLength(MAX_FLOW_ARCS);
    expect(base.filter((e) => e.value === null)).toHaveLength(20);
    expect(flowRestShare(m)).toEqual({ valued: 480, unknown: 20 });
  });

  it('draws the worst 100 edges at rest by default', () => {
    const m = meshModel(300, 5);
    expect(m.edges).toHaveLength(1500);
    const base = flowBaseEdges(m);
    expect(base).toHaveLength(DEFAULT_FLOW_REST_ARCS);
    expect(base).toEqual(m.edges.slice(0, 100));
    const worstLeftOut = m.edges[100].value!;
    expect(Math.min(...base.map((edge) => edge.value!))).toBeGreaterThanOrEqual(worstLeftOut);
  });

  it('draws as many arcs at rest as the option says, and never more than MAX_FLOW_ARCS', () => {
    expect(flowBaseEdges(meshModel(300, 5, { flowRestArcs: 20 }))).toHaveLength(20);
    const most = meshModel(300, 5, { flowRestArcs: 500 });
    expect(flowBaseEdges(most)).toEqual(most.edges.slice(0, MAX_FLOW_ARCS));
    expect(flowBaseEdges(meshModel(300, 5, { flowRestArcs: 100000 }))).toHaveLength(MAX_FLOW_ARCS);
    // A hovered cell is not limited by the option: it shows its own edges.
    const few = meshModel(300, 5, { flowRestArcs: 1 });
    expect(flowBaseEdges(few)).toHaveLength(1);
    expect(flowFocusEdges(few, [pathKey(['node-a150'])])!.length).toBe(10);
  });

  it('draws nothing at rest in hover mode', () => {
    expect(flowBaseEdges(meshModel(10, 2, { flowShow: 'hover' }))).toEqual([]);
  });
});

describe('flowFocusEdges', () => {
  // A ring over three hosts, and two edges of node-b2 that are on no path.
  const columns = {
    src_host: ['node-a1', 'node-a2', 'node-b1', 'node-b2', 'node-b2'],
    dst_host: ['node-a2', 'node-b1', 'node-a1', 'node-b1', 'node-a2'],
    loss: [1, 2, 3, 4, 5],
  };
  const plainFrame = edgeTable(columns);
  const ringFrame = edgeTable({ ...columns, job: ['ring-a', 'ring-a', 'ring-a', '', ''], hop: [1, 2, 3, null, null] });

  it('returns every edge of the node, in and out, worst first', () => {
    const m = model([plainFrame]);
    expect(pairs(flowFocusEdges(m, [B2])!)).toEqual([`${B2}>${A2}=5`, `${B2}>${B1}=4`]);
    expect(pairs(flowFocusEdges(m, [A1])!)).toEqual([`${B1}>${A1}=3`, `${A1}>${A2}=1`]);
  });

  it('adds the other edges of the paths the node is on', () => {
    const m = model([ringFrame], { flowOrderLabel: 'hop', flowPathLabel: 'job' });
    // node-a1 is on ring-a only: the whole ring, but not the unrelated edges of node-b2.
    expect(pairs(flowFocusEdges(m, [A1])!)).toEqual([`${B1}>${A1}=3`, `${A2}>${B1}=2`, `${A1}>${A2}=1`]);
    expect(m.byPath.get('ring-a')!.map((index) => m.edges[index].hops[0].order)).toEqual([1, 2, 3]);
  });

  it('returns null for a node without edges, so an unrelated cell dims nothing', () => {
    const m = model([edgeTable({ src_host: ['node-a1'], dst_host: ['node-a2'], loss: [1] })]);
    expect(flowFocusEdges(m, [B2])).toBeNull();
    expect(flowFocusEdges(m, [])).toBeNull();
  });

  it('accepts several nodes, as a selection would pass them', () => {
    const m = model([plainFrame]);
    expect(pairs(flowFocusEdges(m, [A1, B2])!)).toEqual([
      `${B2}>${A2}=5`,
      `${B2}>${B1}=4`,
      `${B1}>${A1}=3`,
      `${A1}>${A2}=1`,
    ]);
  });

  it('resolves a cell to the node its edges are attached to', () => {
    const m = model([plainFrame]);
    const cell = { path: ['zone-b', '2', 'gpu1'], labels: {}, values: new Map() };
    expect(flowNodeKey(m, cell)).toBe(B2);
  });

  it('is bounded by MAX_FLOW_ARCS for a node with more edges, and keeps its edges without a value', () => {
    // One host with 600 healthy edges and 20 edges whose probe returned nothing.
    const names = Array.from({ length: 621 }, (_, i) => `node-a${i}`);
    const lv: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'host' }];
    const rows: NormalizedRow[] = names.map((host) => ({ labels: { host }, value: 1, refId: 'A' }));
    const opts = options({ levels: lv });
    const frame = edgeTable({
      src_host: names.slice(1).map(() => names[0]),
      dst_host: names.slice(1),
      loss: names.slice(1).map((_, i) => (i >= 600 ? null : i)),
    });
    const m = buildFlowModel([frame], hierarchy(rows, lv), opts, resolveFlowConfig(opts)!, theme, 'utc');
    const focus = flowFocusEdges(m, [pathKey([names[0]])])!;
    expect(focus).toHaveLength(MAX_FLOW_ARCS);
    expect(focus.filter((e) => e.value === null)).toHaveLength(20);
    // The valued ones that are kept are the worst.
    expect(focus[0].value).toBe(599);
    expect(Math.min(...focus.filter((e) => e.value !== null).map((e) => e.value!))).toBe(120);
  });

  it('looks at the edges it returns, not at every edge of the model', () => {
    const m = meshModel(2000, 5);
    expect(m.edges).toHaveLength(10000);
    let reads = 0;
    const counted = { ...m, edges: new Proxy(m.edges, { get: (target, key) => (reads++, Reflect.get(target, key)) }) };
    const focus = flowFocusEdges(counted, [pathKey(['node-a7'])])!;
    expect(focus).toHaveLength(10);
    expect(reads).toBeLessThanOrEqual(4 * focus.length);
  });
});

describe('summarizeFlowNode', () => {
  const columns = {
    src_host: ['node-a1', 'node-a1', 'node-b1', 'node-a2'],
    dst_host: ['node-a2', 'node-b1', 'node-a1', 'node-a1'],
    loss: [1, 0, 7, 2],
  };
  const frame = edgeTable(columns);
  const ringFrame = edgeTable({ ...columns, job: ['ring-a', 'ring-a', 'ring-a', ''], hop: [1, 3, 2, null] });

  it('counts edges and peers and names the worst peer', () => {
    const summary = summarizeFlowNode(model([frame]), A1)!;
    expect(summary).toMatchObject({ outCount: 2, inCount: 2, peerCount: 2 });
    expect(summary.node.label).toBe('node-a1');
    expect(summary.worst).toMatchObject({ direction: 'in', peer: { label: 'node-b1' }, edge: { value: 7 } });
  });

  it('follows the worse direction', () => {
    const summary = summarizeFlowNode(model([frame], { flowWorst: 'low' }), A1)!;
    expect(summary.worst).toMatchObject({ direction: 'out', peer: { label: 'node-b1' }, edge: { value: 0 } });
  });

  it('lists the hops of the node in path and hop order', () => {
    const summary = summarizeFlowNode(model([ringFrame], { flowOrderLabel: 'hop', flowPathLabel: 'job' }), A1)!;
    expect(summary.hops).toEqual([
      { path: 'ring-a', order: 1, direction: 'out' },
      { path: 'ring-a', order: 2, direction: 'in' },
      { path: 'ring-a', order: 3, direction: 'out' },
    ]);
  });

  it('is null for a node without edges that pass the filter', () => {
    expect(summarizeFlowNode(model([frame]), B2)).toBeNull();
    expect(summarizeFlowNode(model([frame], { flowThreshold: 5 }), A2)).toBeNull();
  });
});

describe('flow overlay bounds', () => {
  // The worst case the model accepts: MAX_FLOW_ROWS rows that are all distinct edges. One build takes
  // about 100 ms on an idle machine. The budget is far above that and applies to the fastest of three
  // builds, so it catches a quadratic step and not a busy machine.
  it('builds the model at the row bound within its time budget', () => {
    const hosts = 150; // 150 × 149 ordered pairs > MAX_FLOW_ROWS
    let fastest = Infinity;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const m = meshModel(hosts, hosts - 1);
      fastest = Math.min(fastest, performance.now() - start);
      expect(m.stats.readRows).toBe(MAX_FLOW_ROWS);
      expect(m.edges).toHaveLength(MAX_FLOW_ROWS);
    }
    expect(fastest).toBeLessThan(2000);
  });
});
