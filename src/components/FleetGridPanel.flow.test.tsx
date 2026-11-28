import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, FleetGridOptions } from '../types';
import { FleetGridPanel } from './FleetGridPanel';
import { fetchDrilldownFrames } from '../drilldown/requery';

// The flow overlay as wired into the panel: which queries feed the cells, when the overlay canvas
// exists, and what a hover repaints. Parsing, geometry and drawing have their own unit tests.

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelDataErrorView: () => <div>No data</div>,
}));

jest.mock('../drilldown/requery', () => ({
  fetchDrilldownFrames: jest.fn(),
}));

jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
}));

const mockFetch = fetchDrilldownFrames as jest.Mock;

// Four hosts in a row (flow layout, 40 px cells): node-a1 [0,40), node-a2 [41,81), node-a3 [82,122), node-a4 [123,163).
const HOSTS = ['node-a1', 'node-a2', 'node-a3', 'node-a4'];
const cells = (refId = 'A') =>
  toDataFrame({
    refId,
    fields: [
      { name: 'host', type: FieldType.string, values: HOSTS },
      { name: 'power', type: FieldType.number, values: [100, 200, 300, 400] },
    ],
  });

const edges = (rows: Array<[string, string, number | null]>, refId = 'E') =>
  toDataFrame({
    refId,
    fields: [
      { name: 'src_host', type: FieldType.string, values: rows.map((r) => r[0]) },
      { name: 'dst_host', type: FieldType.string, values: rows.map((r) => r[1]) },
      { name: 'loss', type: FieldType.number, values: rows.map((r) => r[2]) },
    ],
  });

const RING: Array<[string, string, number | null]> = [
  ['node-a1', 'node-a2', 0],
  ['node-a2', 'node-a3', 2.5],
  ['node-a3', 'node-a1', 0],
];

const flowOptions: Partial<FleetGridOptions> = {
  flowRefId: 'E',
  flowEndpoints: [{ level: 'host', source: 'src_host', destination: 'dst_host' }],
};

// `ran` lists the refIds of the queries that ran; by default every frame's query.
const makeProps = (frames: unknown[], options: Partial<FleetGridOptions> = flowOptions, ran?: string[]): any => ({
  id: 1,
  width: 400,
  height: 300,
  timeZone: 'browser',
  timeRange: getDefaultTimeRange(),
  data: {
    series: frames,
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    request: {
      requestId: 'Q1',
      targets: (ran ?? (frames as Array<{ refId: string }>).map((f) => f.refId)).map((refId) => ({ refId })),
    },
  },
  options: {
    levels: [{ ...DEFAULT_LEVEL, label: 'host' }],
    displayMode: 'single',
    showValues: true,
    missingColor: '#444',
    spatialAggregation: 'max',
    reduceCalc: 'lastNotNull',
    ...options,
  },
});

const cellCanvas = () => document.querySelector('canvas:not([data-testid])') as HTMLCanvasElement;
// The layer of the arcs at rest and the layer of the arcs in focus.
const restLayer = () => screen.queryByTestId('flow-overlay') as HTMLCanvasElement | null;
const focusLayer = () => screen.queryByTestId('flow-focus') as HTMLCanvasElement | null;
const container = () => cellCanvas().parentElement as HTMLElement;
type CanvasEvent = { type: string; props: { value?: number } };
const eventsOf = (canvas: HTMLCanvasElement) =>
  (canvas.getContext('2d') as unknown as { __getEvents(): CanvasEvent[] }).__getEvents();
// The canvas mock accumulates events across paints, and every paint of a canvas starts with one clearRect.
const paints = (canvas: HTMLCanvasElement) => eventsOf(canvas).filter((e) => e.type === 'clearRect').length;
// Arcs in a layer's current picture. A layer without arcs holds no backing store (0 x 0).
const arcsIn = (canvas: HTMLCanvasElement) => {
  if (canvas.width === 0) {
    return 0;
  }
  const all = eventsOf(canvas);
  const last = all.slice(all.map((e) => e.type).lastIndexOf('clearRect'));
  return last.filter((e) => e.type === 'quadraticCurveTo').length;
};
const hoverHost = (index: number, y = 5) => fireEvent.mouseMove(container(), { clientX: index * 41 + 10, clientY: y });

describe('FleetGridPanel flow overlay', () => {
  it('stays off without an edge query, even when a query carries source and destination labels', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)], {})} />);
    expect(restLayer()).not.toBeInTheDocument();
    expect(focusLayer()).not.toBeInTheDocument();
    expect(screen.queryByTestId('flow-legend')).not.toBeInTheDocument();
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    // As before the feature, query E is an ordinary metric: it is offered in the selector.
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    hoverHost(0);
    expect(screen.queryByTestId('flow-tooltip')).not.toBeInTheDocument();
  });

  it('draws the edge query on its own canvas and keeps it out of the cell metrics', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)])} />);
    expect(restLayer()).toBeInTheDocument();
    expect(restLayer()).toHaveStyle({ position: 'absolute', pointerEvents: 'none', opacity: '1' });
    expect(focusLayer()).toHaveStyle({ position: 'absolute', pointerEvents: 'none' });
    // The layers start at the cell canvas's origin and are as high as it. The grid (163 px) is narrower
    // than the panel (400 px), so they are as wide as the panel: arcs have room beside the grid.
    expect(restLayer()!.height).toBe(cellCanvas().height);
    expect([cellCanvas().width, restLayer()!.width]).toEqual([163, 400]);
    // One cell metric is left, so there is no selector, and no row of the edge query became a cell.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('3 edges');
    expect(arcsIn(restLayer()!)).toBe(3);
    expect(arcsIn(focusLayer()!)).toBe(0);
  });

  it('does not list the edge query in the cell tooltip', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)])} />);
    hoverHost(3); // node-a4 has no edges
    const tooltip = screen.getByRole('tooltip');
    expect(within(tooltip).getByText('400')).toBeInTheDocument();
    expect(within(tooltip).queryByText('E')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flow-tooltip')).not.toBeInTheDocument();
  });

  it('reports edge rows it cannot draw in the warning banner and still draws the rest', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges([...RING, ['node-a1', 'node-x9', 1]])])} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Flow overlay: 1/4 edge rows were left out (1 with an endpoint that matches no cell or group; for example dst_host=node-x9)'
    );
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('3 edges');
    // The banner cuts a long warning in a narrow panel; its title has the full text.
    const warning = screen.getByRole('alert').firstElementChild as HTMLElement;
    expect(warning).toHaveAttribute('title', warning.textContent);
  });

  it('does not warn when the edge query ran and returned nothing: a healthy fabric is not a fault', () => {
    // Query E ran (the request lists it) and returned no frame, or a frame without rows.
    for (const frames of [[cells()], [cells(), edges([])]]) {
      const { unmount } = render(<FleetGridPanel {...makeProps(frames, flowOptions, ['A', 'E'])} />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('no edges');
      expect(screen.queryByTestId('flow-legend-error')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('says so when no query has the refId of the edge query, in the banner and in the legend', () => {
    // No query E at all, and a query E that is hidden and so did not run.
    for (const targets of [[{ refId: 'A' }], [{ refId: 'A' }, { refId: 'E', hide: true }]]) {
      const props = makeProps([cells()]);
      props.data.request.targets = targets;
      const { unmount } = render(<FleetGridPanel {...props} />);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Flow overlay: no query with the refId "E" ran (it does not exist or is hidden)'
      );
      expect(screen.getByTestId('flow-legend-error')).toHaveTextContent('no query "E"');
      unmount();
    }
  });

  it('takes the refId without the spaces around it', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)], { ...flowOptions, flowRefId: 'E ' })} />);
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('3 edges');
    // Query E is the edge query, so it is not a second cell metric.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('adds the peers and the worst peer of the hovered cell to the tooltip', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)])} />);
    hoverHost(1);
    const section = screen.getByTestId('flow-tooltip');
    expect(section).toHaveTextContent('Flows: 1 out, 1 in, 2 peers');
    expect(section).toHaveTextContent('Worst: to node-a3');
    expect(section).toHaveTextContent('2.5');
  });

  it('paints only the focus layer when the hovered cell changes, and nothing while the pointer stays in a cell', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)])} />);
    const cellPaints = paints(cellCanvas());
    const restPaints = paints(restLayer()!);

    hoverHost(0);
    expect(arcsIn(focusLayer()!)).toBe(2); // the two edges of node-a1
    const focusPaints = paints(focusLayer()!);
    hoverHost(0, 20); // the same cell, another pixel
    hoverHost(0, 30);
    expect(paints(focusLayer()!)).toBe(focusPaints);
    hoverHost(1);
    expect(paints(focusLayer()!)).toBe(focusPaints + 1);
    // A cell without edges emphasises nothing, and so does leaving the grid.
    hoverHost(3);
    expect(arcsIn(focusLayer()!)).toBe(0);
    fireEvent.mouseLeave(container());
    expect(arcsIn(focusLayer()!)).toBe(0);
    // None of this painted the cells or the arcs at rest again.
    expect(paints(cellCanvas())).toBe(cellPaints);
    expect(paints(restLayer()!)).toBe(restPaints);
  });

  it('dims the arcs at rest while a cell with edges is hovered', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges([...RING, ['node-a3', 'node-a4', 1]])])} />);
    expect(restLayer()).toHaveStyle({ opacity: '1' });
    hoverHost(0);
    expect(restLayer()).toHaveStyle({ opacity: '0.22' });
    expect(arcsIn(restLayer()!)).toBe(4);
    hoverHost(3); // node-a4 has one edge
    expect(restLayer()).toHaveStyle({ opacity: '0.22' });
    expect(arcsIn(focusLayer()!)).toBe(1);
    fireEvent.mouseLeave(container());
    expect(restLayer()).toHaveStyle({ opacity: '1' });
  });

  it('draws arcs only for the hovered cell in hover mode', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)], { ...flowOptions, flowShow: 'hover' })} />);
    expect(arcsIn(restLayer()!)).toBe(0);
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('3 edges, shown on hover');
    hoverHost(0);
    expect(arcsIn(restLayer()!)).toBe(0);
    expect(arcsIn(focusLayer()!)).toBe(2);
    fireEvent.mouseLeave(container());
    expect(arcsIn(focusLayer()!)).toBe(0);
  });

  it('keeps the edges of the clicked cell emphasised while its popover is open', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)], { ...flowOptions, flowShow: 'hover' })} />);
    fireEvent.click(container(), { clientX: 10, clientY: 5 });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(arcsIn(focusLayer()!)).toBe(2);
    fireEvent.mouseLeave(container());
    expect(arcsIn(focusLayer()!)).toBe(2);
  });

  it('keeps that emphasis while the pointer is on a cell without edges, and gives it to a cell that has edges', () => {
    // node-a1 has two edges, node-a2 and node-a3 one each, node-a4 none.
    const star: Array<[string, string, number | null]> = [
      ['node-a1', 'node-a2', 1],
      ['node-a1', 'node-a3', 2],
    ];
    render(<FleetGridPanel {...makeProps([cells(), edges(star)])} />);
    fireEvent.click(container(), { clientX: 10, clientY: 5 });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(arcsIn(focusLayer()!)).toBe(2);

    // node-a4 has nothing to show: the edges of the popover's cell stay, and the rest stays dimmed.
    hoverHost(3);
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(arcsIn(focusLayer()!)).toBe(2);
    expect(restLayer()).toHaveStyle({ opacity: '0.22' });
    // The tooltip is node-a4's: it must not describe the edges of node-a1.
    expect(screen.getByRole('tooltip')).toHaveTextContent('400');
    expect(screen.queryByTestId('flow-tooltip')).not.toBeInTheDocument();

    // node-a2 has an edge of its own: the pointer wins.
    hoverHost(1);
    expect(arcsIn(focusLayer()!)).toBe(1);
    expect(screen.getByTestId('flow-tooltip')).toHaveTextContent('Flows: 0 out, 1 in, 1 peer');

    // Off the grid, the popover's cell is in focus again.
    fireEvent.mouseLeave(container());
    expect(arcsIn(focusLayer()!)).toBe(2);
  });

  it('applies the threshold filter and says how many edges pass it', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)], { ...flowOptions, flowThreshold: 0 })} />);
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('1 of 3 edges > 0');
  });

  it('shows the warning instead of an overlay when the endpoint mapping is missing', () => {
    render(<FleetGridPanel {...makeProps([cells(), edges(RING)], { flowRefId: 'E' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Flow overlay: map at least one hierarchy label');
    // The edge query is still not a cell metric.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  describe('drilldown requery', () => {
    beforeEach(() => mockFetch.mockReset());

    it('leaves the edge query out of the instant check and of the range requery', () => {
      mockFetch.mockReturnValue(new Promise(() => undefined));
      // Only the edge query is instant: the cells already come from a range query, so nothing is fetched.
      const rangeCells = makeProps([cells(), edges(RING)]);
      rangeCells.data.request.targets = [{ refId: 'A' }, { refId: 'E', instant: true }];
      const view = render(<FleetGridPanel {...rangeCells} />);
      fireEvent.click(container(), { clientX: 10, clientY: 5 });
      expect(mockFetch).not.toHaveBeenCalled();
      view.unmount();

      // The cell query is instant: the requery runs, without the (possibly very large) edge query.
      const instantCells = makeProps([cells(), edges(RING)]);
      instantCells.data.request.targets = [
        { refId: 'A', instant: true },
        { refId: 'E', instant: true },
      ];
      render(<FleetGridPanel {...instantCells} />);
      fireEvent.click(container(), { clientX: 10, clientY: 5 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0].targets).toEqual([{ refId: 'A', instant: true }]);
      expect(mockFetch.mock.calls[0][0].requestId).toBe('Q1');
    });
  });
});
