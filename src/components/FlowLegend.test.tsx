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

const model = (
  edges: FlowEdge[],
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
  edges,
  nodes: new Map(),
  byNode: new Map(),
  byPath: new Map(),
  stats: {
    totalRows: edges.length,
    readRows: edges.length,
    missingLabel: 0,
    unmatched: 0,
    ambiguous: 0,
    selfEdges: 0,
    invalidOrder: 0,
    edgeCount: edges.length,
    noValue: 0,
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
    expect(flowLegendSummary(model([edge(1), edge(2)]))).toMatchObject({ text: '2 edges', bound: false });
    expect(flowLegendSummary(model([])).text).toBe('no edges');
  });

  it('says how many edges are drawn when the draw bound leaves some out', () => {
    const many = Array.from({ length: MAX_FLOW_ARCS + 234 }, (_, i) => edge(i));
    expect(flowLegendSummary(model(many))).toMatchObject({
      text: `${MAX_FLOW_ARCS} of ${MAX_FLOW_ARCS + 234} edges drawn, worst first`,
      bound: true,
    });
  });

  it('names the filter with the formatted threshold and its direction', () => {
    const filtered = model([edge(1)], {}, { edgeCount: 4 });
    expect(flowLegendSummary(withConfig(filtered, { threshold: 0.5 })).text).toBe('1 of 4 edges > 0.5%');
    expect(flowLegendSummary(withConfig(filtered, { threshold: 99, worst: 'low' })).text).toBe('1 of 4 edges < 99%');
    expect(flowLegendSummary(withConfig(model([], {}, { edgeCount: 4 }), { threshold: 0.5 })).text).toBe(
      '0 of 4 edges > 0.5%'
    );
  });

  it('says that hover mode draws on hover', () => {
    expect(flowLegendSummary(withConfig(model([edge(1)]), { show: 'hover' })).text).toBe('1 edges, shown on hover');
  });

  it('lists what was read and what was left out', () => {
    const m = model(
      [edge(1), edge(2, null)],
      {},
      { totalRows: 50000, readRows: 20000, selfEdges: 3, noValue: 1, unmatched: 2 }
    );
    expect(flowLegendSummary(m).details).toEqual([
      'Edge query E: 20000 of 50000 rows read',
      '3 rows start and end at the same group (not drawn)',
      '1 edges have no value (dashed)',
      '2 rows left out (see the warning)',
    ]);
    expect(flowLegendSummary(withConfig(m, { threshold: 0 })).details[2]).toBe('1 edges have no value (not drawn)');
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
    render(<FlowLegend model={model([edge(1), edge(2)])} width={800} />);
    const legend = screen.getByTestId('flow-legend');
    expect(legend).toHaveTextContent('Flows');
    expect(legend).toHaveTextContent('loss');
    expect(legend).toHaveTextContent('0%');
    expect(legend).toHaveTextContent('5%');
    expect(screen.getByTestId('range-gradient')).toBeInTheDocument();
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('2 edges');
    expect(legend).toHaveAttribute('title', 'Edge query E: 2 of 2 rows read');
  });

  it('renders nothing while the overlay is off', () => {
    const { container } = render(<FlowLegend model={null} width={800} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows no color scale when no edge has a value', () => {
    render(<FlowLegend model={model([edge(1, null)])} width={800} />);
    expect(screen.queryByTestId('range-legend')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('1 edges');
  });

  it('marks the count when the draw bound binds', () => {
    const many = Array.from({ length: MAX_FLOW_ARCS + 1 }, (_, i) => edge(i));
    render(<FlowLegend model={model(many)} width={800} />);
    expect(screen.getByTestId('flow-legend-count')).toHaveStyle({ color: theme.colors.warning.text });
  });
});
