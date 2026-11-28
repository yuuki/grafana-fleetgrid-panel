import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme } from '@grafana/data';
import { MetricInfo } from '../data/display';
import { FlowEdge, FlowModel, MAX_FLOW_ARCS } from '../data/edges';
import { FlowLegend, flowLegendSummary, formatFlowValue } from './FlowLegend';

const theme = createTheme();
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  useTheme2: () => theme,
}));

const metricInfo: MetricInfo = {
  refId: 'E',
  name: 'loss',
  effectiveMin: 0,
  effectiveMax: 5,
  minConfigured: false,
  maxConfigured: false,
  processor: ((value: number) => ({
    text: String(value),
    suffix: '%',
    numeric: value,
    color: value >= 1 ? '#ff0000' : '#00ff00',
  })) as MetricInfo['processor'],
  field: {} as MetricInfo['field'],
  frame: {} as MetricInfo['frame'],
};

const edge = (index: number, value: number | null = 1): FlowEdge => ({
  source: `s${index}`,
  destination: `d${index}`,
  value,
  rowCount: 1,
  hops: [],
});
const edges = (count: number, value: number | null = 1, from = 0) =>
  Array.from({ length: count }, (_, i) => edge(from + i, value));

// A model as buildFlowModel returns it: the edges with a value first, then those without one.
const model = (
  list: FlowEdge[],
  over: Partial<FlowModel> = {},
  stats: Partial<FlowModel['stats']> = {}
): FlowModel => ({
  config: {
    refId: 'E',
    endpoints: [{ level: 'host', source: 'src_host', destination: 'dst_host' }],
    incompleteEndpoints: 0,
    show: 'always',
    worst: 'high',
    threshold: undefined,
    orderLabel: '',
    pathLabel: '',
  },
  depth: 2,
  levelLabel: 'host',
  groupLevel: true,
  edges: list,
  valuedCount: list.filter((e) => e.value !== null).length,
  nodes: new Map(),
  byNode: new Map(),
  byPath: new Map(),
  stats: {
    totalRows: list.length,
    readRows: list.length,
    missingLabel: 0,
    unmatched: 0,
    ambiguous: 0,
    selfEdges: 0,
    invalidOrder: 0,
    edgeCount: list.length,
    noValue: list.filter((e) => e.value === null).length,
    examples: [],
    ...stats,
  },
  warnings: [],
  metricInfo,
  ...over,
});

const withConfig = (m: FlowModel, config: Partial<FlowModel['config']>): FlowModel => ({
  ...m,
  config: { ...m.config, ...config },
});

describe('flowLegendSummary', () => {
  it('counts the edges', () => {
    expect(flowLegendSummary(model(edges(2)))).toMatchObject({ text: '2 edges', notes: [], bound: false });
    expect(flowLegendSummary(model(edges(1))).text).toBe('1 edge');
    expect(flowLegendSummary(model([])).text).toBe('no edges');
  });

  it('says how many edges are drawn when the draw bound leaves some out', () => {
    expect(flowLegendSummary(model(edges(MAX_FLOW_ARCS + 234)))).toMatchObject({
      text: `${MAX_FLOW_ARCS} of ${MAX_FLOW_ARCS + 234} edges drawn, worst first`,
      notes: [],
      bound: true,
    });
  });

  it('does not claim that arcs are drawn at rest in hover mode', () => {
    expect(flowLegendSummary(withConfig(model(edges(MAX_FLOW_ARCS + 234)), { show: 'hover' }))).toMatchObject({
      text: `${MAX_FLOW_ARCS + 234} edges, shown on hover`,
      bound: false,
    });
  });

  it('names the filter with the formatted threshold and its direction', () => {
    const filtered = model(edges(1), {}, { edgeCount: 4 });
    expect(flowLegendSummary(withConfig(filtered, { threshold: 0.5 })).text).toBe('1 of 4 edges > 0.5%');
    expect(flowLegendSummary(withConfig(filtered, { threshold: 99, worst: 'low' })).text).toBe('1 of 4 edges < 99%');
    expect(flowLegendSummary(withConfig(model([], {}, { edgeCount: 4 }), { threshold: 0.5 })).text).toBe(
      '0 of 4 edges > 0.5%'
    );
  });

  it('says that hover mode draws on hover', () => {
    expect(flowLegendSummary(withConfig(model(edges(1)), { show: 'hover' })).text).toBe('1 edge, shown on hover');
  });

  describe('edges without a value', () => {
    it('are dashed and need no remark while all of them are drawn', () => {
      const summary = flowLegendSummary(model([...edges(3), ...edges(2, null, 3)]));
      expect(summary).toMatchObject({ text: '5 edges', notes: [], bound: false });
      expect(summary.details).toContain('2 edges without a value (dashed)');
    });

    it('says in the visible text how many of them the draw bound left out', () => {
      // 600 healthy edges and 300 whose probe returned nothing: half of the bound goes to each.
      const summary = flowLegendSummary(model([...edges(600, 0), ...edges(300, null, 600)]));
      expect(summary.text).toBe(`${MAX_FLOW_ARCS} of 900 edges drawn, worst first`);
      expect(summary.notes).toEqual([`${MAX_FLOW_ARCS / 2} of 300 edges without a value drawn`]);
      expect(summary.details.join(' ')).not.toContain('dashed');
    });

    it('needs no remark when the bound cuts only edges with a value', () => {
      const summary = flowLegendSummary(model([...edges(600, 0), ...edges(20, null, 600)]));
      expect(summary.text).toBe(`${MAX_FLOW_ARCS} of 620 edges drawn, worst first`);
      expect(summary.notes).toEqual([]);
      expect(summary.details).toContain('20 edges without a value (dashed)');
    });

    it('says in the visible text that a filter does not draw them', () => {
      // The filter left three valued edges; the two edges without a value are not among the candidates.
      const filtered = withConfig(model(edges(3), {}, { edgeCount: 6, noValue: 2 }), { threshold: 0 });
      expect(flowLegendSummary(filtered).notes).toEqual(['2 edges without a value not drawn']);
      const one = withConfig(model(edges(3), {}, { edgeCount: 6, noValue: 1 }), { threshold: 0 });
      expect(flowLegendSummary(one).notes).toEqual(['1 edge without a value not drawn']);
    });
  });

  it('says in the visible text that only the worst rows of an oversized result are used', () => {
    const m = model(edges(MAX_FLOW_ARCS + 1), {}, { totalRows: 25001, readRows: 20000 });
    expect(flowLegendSummary(m)).toMatchObject({
      text: `${MAX_FLOW_ARCS} of ${MAX_FLOW_ARCS + 1} edges drawn, worst first`,
      notes: ['worst 20000 of 25001 rows used'],
    });
    expect(flowLegendSummary(model(edges(2))).notes).toEqual([]);
  });

  it('lists what was read and what was left out', () => {
    const m = model(edges(2), {}, { totalRows: 50000, readRows: 20000, selfEdges: 3, unmatched: 2 });
    expect(flowLegendSummary(m).details).toEqual([
      'Edge query E: 20000 of 50000 rows used',
      '3 rows start and end at the same group (not drawn)',
      '2 rows left out (see the warning)',
    ]);
    expect(flowLegendSummary({ ...m, groupLevel: false }).details[1]).toBe(
      '3 rows start and end at the same cell (not drawn)'
    );
  });
});

describe('formatFlowValue', () => {
  it('formats with the edge query field config, and says when there is no value', () => {
    expect(formatFlowValue(model([]), 2.5)).toBe('2.5%');
    expect(formatFlowValue(model([]), null)).toBe('No data');
    expect(formatFlowValue(model([], { metricInfo: undefined }), 2.5)).toBe('2.5');
  });
});

describe('FlowLegend', () => {
  it('shows the color scale of the edge query and the edge count', () => {
    render(<FlowLegend model={model(edges(2))} />);
    const legend = screen.getByTestId('flow-legend');
    expect(legend).toHaveTextContent('Flows');
    expect(screen.getByTestId('flow-legend-scale')).toHaveTextContent('loss');
    expect(screen.getByLabelText('loss flow color scale, Auto, 0% to 5%')).toBeInTheDocument();
    expect(screen.getByTestId('flow-legend-gradient')).toBeInTheDocument();
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('2 edges');
    expect(legend).toHaveAttribute('title', 'Edge query E: 2 of 2 rows used');
  });

  it('does not reuse the test ids of the cell legend', () => {
    render(<FlowLegend model={model(edges(2))} />);
    expect(screen.queryByTestId('range-legend')).not.toBeInTheDocument();
    expect(screen.queryByTestId('range-gradient')).not.toBeInTheDocument();
  });

  it('renders nothing while the overlay is off', () => {
    const { container } = render(<FlowLegend model={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows no color scale when no edge has a value', () => {
    render(<FlowLegend model={model(edges(1, null))} />);
    expect(screen.queryByTestId('flow-legend-scale')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('1 edge');
  });

  it('marks the count when the draw bound binds, and writes its remarks as visible text that can wrap', () => {
    render(<FlowLegend model={model([...edges(600, 0), ...edges(300, null, 600)])} />);
    expect(screen.getByTestId('flow-legend-count')).toHaveStyle({ color: theme.colors.warning.text });
    const note = screen.getByTestId('flow-legend-note');
    expect(note).toHaveTextContent(`${MAX_FLOW_ARCS / 2} of 300 edges without a value drawn`);
    expect(note).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(screen.getByTestId('flow-legend')).toHaveStyle({ flexWrap: 'wrap' });
  });
});
