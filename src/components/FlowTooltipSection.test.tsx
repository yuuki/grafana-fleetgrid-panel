import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme } from '@grafana/data';
import { MetricInfo } from '../data/display';
import { FlowModel, FlowNodeSummary, MAX_FLOW_ARCS } from '../data/edges';
import { FlowTooltipSection } from './FlowTooltipSection';

const theme = createTheme();
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  useTheme2: () => theme,
}));

const metricInfo = {
  processor: ((value: number) => ({
    text: String(value),
    suffix: '%',
    numeric: value,
    color: '#ff0000',
  })) as MetricInfo['processor'],
} as MetricInfo;

const model = (over: Partial<FlowModel> = {}): FlowModel =>
  ({ levelLabel: 'host', groupLevel: true, metricInfo, ...over }) as FlowModel;

const node = (label: string) => ({ key: label, path: [label], label });

const summary = (over: Partial<FlowNodeSummary> = {}): FlowNodeSummary => ({
  node: node('node-a1'),
  outCount: 3,
  inCount: 2,
  peerCount: 4,
  worst: {
    edge: { source: 'node-a1', destination: 'node-b4', value: 2.5, rowCount: 1, hops: [] },
    peer: node('node-b4'),
    direction: 'out',
  },
  hops: [],
  ...over,
});

const section = () => screen.getByTestId('flow-tooltip');

describe('FlowTooltipSection', () => {
  it('names the group the edges belong to, the peer count and the worst peer', () => {
    render(<FlowTooltipSection model={model()} summary={summary()} missingColor="#444" />);
    expect(section()).toHaveTextContent('Flows of host node-a1: 3 out, 2 in, 4 peers');
    expect(section()).toHaveTextContent('Worst: to node-b4');
    expect(section()).toHaveTextContent('2.5%');
  });

  it('does not name a group when the edges belong to the cell itself', () => {
    const one = summary({ outCount: 0, inCount: 1, peerCount: 1 });
    one.worst.direction = 'in';
    render(<FlowTooltipSection model={model({ groupLevel: false })} summary={one} missingColor="#444" />);
    expect(section()).toHaveTextContent('Flows: 0 out, 1 in, 1 peer');
    expect(section()).not.toHaveTextContent('1 peers');
    expect(section()).toHaveTextContent('Worst: from node-b4');
  });

  it('says No data for a worst edge without a value instead of a number', () => {
    const unknown = summary();
    unknown.worst.edge = { ...unknown.worst.edge, value: null };
    render(<FlowTooltipSection model={model()} summary={unknown} missingColor="#444" />);
    expect(section()).toHaveTextContent('No data');
    expect(section()).not.toHaveTextContent('0%');
  });

  it('lists the first hops of the node and counts the rest', () => {
    const hops: FlowNodeSummary['hops'] = [
      { path: 'ring-a', order: 2, direction: 'in' },
      { path: 'ring-a', order: 3, direction: 'out' },
      { path: '', order: 1, direction: 'out' },
      { path: 'tree-a', order: null, direction: 'in' },
      { path: 'tree-b', order: null, direction: 'in' },
    ];
    render(<FlowTooltipSection model={model()} summary={summary({ hops })} missingColor="#444" />);
    expect(section()).toHaveTextContent('ring-a hop 2 in');
    expect(section()).toHaveTextContent('ring-a hop 3 out');
    expect(section()).toHaveTextContent('Path hop 1 out');
    expect(section()).not.toHaveTextContent('tree-a');
    expect(section()).toHaveTextContent('+2 more hops');
  });

  it('says when a node has more edges than are drawn', () => {
    const crowded = summary({ outCount: MAX_FLOW_ARCS, inCount: 500 });
    render(<FlowTooltipSection model={model()} summary={crowded} missingColor="#444" />);
    expect(section()).toHaveTextContent(`${MAX_FLOW_ARCS} of ${MAX_FLOW_ARCS + 500} edges drawn, worst first`);
  });
});
