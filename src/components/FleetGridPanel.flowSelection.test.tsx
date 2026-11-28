import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, FleetGridOptions } from '../types';
import { FleetGridPanel } from './FleetGridPanel';
import { installPointerEvent, panelUi } from '../testing/selectionPanel';

// Cell selection on a panel that shows a flow overlay. Both read the pointer: the overlay puts the
// hovered cell's edges in focus, and a Shift press selects cells. These tests fix which of the two has
// the pointer when, what a selection does to the arcs (nothing), the order in which the parts are
// stacked, and that the three canvases stay one size when the selection bar takes height from the grid.

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelDataErrorView: () => <div>No data</div>,
}));

// Grafana's Drawer needs ResizeObserver and IntersectionObserver, which jsdom does not have. The
// stand-in renders in a portal on the body, as the real one does. Sparkline depends on uPlot.
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
  Drawer: ({ title, children }: any) =>
    jest.requireActual('react-dom').createPortal(
      <div role="dialog" aria-label={title}>
        {children}
      </div>,
      document.body
    ),
}));

// Four hosts in a row (flow layout, 40 px cells): node-a1 [0,40), node-a2 [41,81), node-a3 [82,122), node-a4 [123,163).
const HOSTS = ['node-a1', 'node-a2', 'node-a3', 'node-a4'];
const cells = () =>
  toDataFrame({
    refId: 'A',
    fields: [
      { name: 'host', type: FieldType.string, values: HOSTS },
      { name: 'power', type: FieldType.number, values: [100, 200, 300, 400] },
    ],
  });

// A ring over the first three hosts; node-a4 has no edges.
const edges = () =>
  toDataFrame({
    refId: 'E',
    fields: [
      { name: 'src_host', type: FieldType.string, values: ['node-a1', 'node-a2', 'node-a3'] },
      { name: 'dst_host', type: FieldType.string, values: ['node-a2', 'node-a3', 'node-a1'] },
      { name: 'loss', type: FieldType.number, values: [0, 2.5, 0] },
    ],
  });

const makeProps = (options: Partial<FleetGridOptions> = {}): any => ({
  id: 1,
  width: 400,
  height: 300,
  timeZone: 'browser',
  timeRange: getDefaultTimeRange(),
  data: {
    series: [cells(), edges()],
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    request: { requestId: 'Q1', targets: [{ refId: 'A' }, { refId: 'E' }] },
  },
  options: {
    levels: [{ ...DEFAULT_LEVEL, label: 'host' }],
    displayMode: 'single',
    showValues: false,
    missingColor: '#444',
    spatialAggregation: 'max',
    reduceCalc: 'lastNotNull',
    flowRefId: 'E',
    flowEndpoints: [{ level: 'host', source: 'src_host', destination: 'dst_host' }],
    ...options,
  },
});

// A point inside the cell of each host.
const HOST = { a1: [10, 20], a2: [51, 20], a3: [92, 20], a4: [133, 20] } as const;

const { container, band, count, pointer, press, release, shiftClick, shiftDrag, ringsDrawn } = panelUi();
installPointerEvent();

const cellCanvas = () => document.querySelector('canvas:not([data-testid])') as HTMLCanvasElement;
const restLayer = () => screen.getByTestId('flow-overlay') as HTMLCanvasElement;
const focusLayer = () => screen.getByTestId('flow-focus') as HTMLCanvasElement;
type CanvasEvent = { type: string };
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
const hover = (point: readonly [number, number]) =>
  fireEvent.mouseMove(container(), { clientX: point[0], clientY: point[1] });

describe('FleetGridPanel cell selection on a flow overlay', () => {
  it('gives the pointer to the selection for as long as a Shift press lasts: no tooltip and no arcs in focus', () => {
    render(<FleetGridPanel {...makeProps()} />);
    hover(HOST.a1);
    expect(arcsIn(focusLayer())).toBe(2);
    expect(restLayer()).toHaveStyle({ opacity: '0.22' });
    expect(screen.getByTestId('flow-tooltip')).toBeInTheDocument();

    // The press ends the hover, and with it the tooltip and the focus: the arcs at rest are back.
    press(HOST.a1);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(arcsIn(focusLayer())).toBe(0);
    expect(restLayer()).toHaveStyle({ opacity: '1' });
    expect(arcsIn(restLayer())).toBe(3);

    // While the button is down, the pointer hovers nothing: a drag over a cell with edges does not
    // put them in focus.
    fireEvent.pointerMove(container(), pointer(HOST.a2));
    hover(HOST.a2);
    expect(band()).toHaveStyle({ display: 'block' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(arcsIn(focusLayer())).toBe(0);
    expect(restLayer()).toHaveStyle({ opacity: '1' });

    // The release selects, and the next move of the pointer hovers again.
    release(HOST.a2);
    expect(count()).toBe('2 cells selected');
    expect(arcsIn(focusLayer())).toBe(0);
    hover(HOST.a2);
    expect(arcsIn(focusLayer())).toBe(2);
    expect(screen.getByTestId('flow-tooltip')).toHaveTextContent('Flows: 1 out, 1 in, 2 peers');
  });

  it('does not put the edges of the selected cells in focus, and hovers a selected cell like any other', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(HOST.a1);
    shiftClick(HOST.a2);
    expect(count()).toBe('2 cells selected');
    expect(ringsDrawn()).toBe(true);
    // The selection alone emphasises nothing and dims nothing.
    expect(arcsIn(focusLayer())).toBe(0);
    expect(restLayer()).toHaveStyle({ opacity: '1' });
    expect(arcsIn(restLayer())).toBe(3);

    // The focus follows the pointer as before, on a selected cell and on one that is not selected.
    hover(HOST.a1);
    expect(arcsIn(focusLayer())).toBe(2);
    hover(HOST.a3);
    expect(arcsIn(focusLayer())).toBe(2);
    hover(HOST.a4); // no edges
    expect(arcsIn(focusLayer())).toBe(0);
    // None of it changed the selection.
    expect(count()).toBe('2 cells selected');
  });

  it('paints the arcs once for the selection bar and not again when the selection changes', () => {
    render(<FleetGridPanel {...makeProps()} />);
    hover(HOST.a4); // the focus layer has been painted once, without arcs
    shiftClick(HOST.a1);
    // The bar took height from the grid's box, so the layers were sized again with the cell canvas.
    const restPaints = paints(restLayer());
    const focusPaints = paints(focusLayer());
    const cellPaints = paints(cellCanvas());

    shiftClick(HOST.a2);
    shiftDrag(HOST.a3, HOST.a4);
    expect(count()).toBe('4 cells selected');
    // A change of the selection repaints the cells (the rings are on the cell canvas) and no arc.
    expect(paints(cellCanvas())).toBeGreaterThan(cellPaints);
    expect(paints(restLayer())).toBe(restPaints);
    expect(paints(focusLayer())).toBe(focusPaints);
    expect(arcsIn(restLayer())).toBe(3);
  });

  it('keeps the two arc layers the size of the cell canvas when the selection bar takes height from the grid', () => {
    render(<FleetGridPanel {...makeProps()} />);
    // Header 32 px of 300 px: the grid's box is 268 px, and the grid (40 px) is shorter than the box.
    expect(container()).toHaveStyle({ height: '268px' });
    const heights = () => [cellCanvas(), restLayer(), focusLayer()].map((canvas) => canvas.style.height);
    expect(heights()).toEqual(['268px', '268px', '268px']);

    shiftClick(HOST.a1);
    // The bar (32 px where it cannot be measured) is taken from the box. A layer higher than the cell
    // canvas would make the grid scroll past its last row.
    expect(container()).toHaveStyle({ height: '236px' });
    expect(heights()).toEqual(['236px', '236px', '236px']);
    expect(restLayer().height).toBe(cellCanvas().height);
    hover(HOST.a1);
    expect(focusLayer().height).toBe(cellCanvas().height);

    fireEvent.click(screen.getByTestId('selection-clear'));
    expect(heights()).toEqual(['268px', '268px', '268px']);
  });

  it('stacks the cells, the arcs, the rubber band and the tooltip in that order', () => {
    render(<FleetGridPanel {...makeProps()} />);
    hover(HOST.a1);
    const tooltip = screen.getByRole('tooltip');
    const order = [cellCanvas(), restLayer(), focusLayer(), band(), tooltip].map((element) =>
      [...container().children].indexOf(element)
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
    // The cell canvas (with the selection rings) is in the flow of the page; the layers are positioned
    // without a z-index, so they lie on it in DOM order. The band and the tooltip lie above by z-index.
    for (const layer of [restLayer(), focusLayer()]) {
      expect(layer).toHaveStyle({ position: 'absolute', pointerEvents: 'none' });
      expect(layer.style.zIndex).toBe('');
    }
    expect(Number(band().style.zIndex)).toBeGreaterThan(0);
    expect(Number(tooltip.style.zIndex)).toBeGreaterThan(Number(band().style.zIndex));
    expect(band()).toHaveStyle({ pointerEvents: 'none' });
  });

  it('selects the cell under a tooltip that carries the flow section, and nothing where it covers another cell', () => {
    render(<FleetGridPanel {...makeProps()} />);
    hover(HOST.a2);
    const tooltip = screen.getByRole('tooltip');
    expect(within(tooltip).getByTestId('flow-tooltip')).toBeInTheDocument();
    // Over another cell the tooltip keeps the press: the viewer sees the tooltip there, not the cell.
    fireEvent.pointerDown(tooltip, pointer(HOST.a3));
    fireEvent.pointerUp(tooltip, pointer(HOST.a3));
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(arcsIn(focusLayer())).toBe(2);
    // Over its own cell the press goes on to the grid and selects the cell.
    fireEvent.pointerDown(tooltip, pointer(HOST.a2));
    fireEvent.pointerUp(container(), pointer(HOST.a2));
    expect(count()).toBe('1 cell selected');
  });

  // An open popover keeps its cell's edges in focus for as long as it is open. A Shift press does not
  // change that rule. Whether the press closes the popover depends on the host: the panel closes it on
  // a pointer-down that reaches the document.
  it('ends the focus that a popover kept where the Shift press closes the popover', () => {
    // The pointer-down reaches the document, as in Grafana 11.6.
    render(<FleetGridPanel {...makeProps()} />);
    fireEvent.click(container(), { clientX: HOST.a1[0], clientY: HOST.a1[1] });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    fireEvent.mouseLeave(container());
    expect(arcsIn(focusLayer())).toBe(2);

    press(HOST.a4);
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    expect(arcsIn(focusLayer())).toBe(0);
    expect(restLayer()).toHaveStyle({ opacity: '1' });
    release(HOST.a4);
    expect(count()).toBe('1 cell selected');
    // The click that ends the press opens no popover.
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });

  it('keeps the popover and its focus through a Shift gesture where the host stops the pointer-down', () => {
    // Grafana 12.4 stops a pointer-down above the panel, so it never reaches the document.
    render(
      <div onPointerDown={(event) => event.stopPropagation()}>
        <FleetGridPanel {...makeProps()} />
      </div>
    );
    fireEvent.click(container(), { clientX: HOST.a1[0], clientY: HOST.a1[1] });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    hover(HOST.a2); // a hovered cell with edges takes the focus from the popover's cell
    expect(screen.getByTestId('flow-tooltip')).toHaveTextContent('Flows: 1 out, 1 in, 2 peers');

    // The press ends the hover. The popover is still open, so its cell is in focus again.
    press(HOST.a4);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(arcsIn(focusLayer())).toBe(2);
    expect(restLayer()).toHaveStyle({ opacity: '0.22' });
    release(HOST.a4);
    expect(count()).toBe('1 cell selected');
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(arcsIn(focusLayer())).toBe(2);

    // Escape closes the popover and leaves the selection; the focus ends with the popover.
    fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Escape' });
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    expect(count()).toBe('1 cell selected');
    expect(arcsIn(focusLayer())).toBe(0);
    expect(restLayer()).toHaveStyle({ opacity: '1' });
  });

  it('leaves the arcs alone when Escape or Clear ends the selection', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftDrag(HOST.a1, HOST.a3);
    expect(count()).toBe('3 cells selected');
    const restPaints = paints(restLayer());
    fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Escape' });
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(ringsDrawn()).toBe(false);
    // The bar is gone, so the layers were sized once more with the cell canvas, and the arcs are there.
    expect(paints(restLayer())).toBe(restPaints + 1);
    expect(arcsIn(restLayer())).toBe(3);
    expect(screen.getByTestId('flow-legend-count')).toHaveTextContent('3 edges');
  });

  it('compares the selected cells for the cell queries only: the edge query is not a cell metric', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(HOST.a1);
    fireEvent.click(screen.getByTestId('selection-compare'));
    const comparison = screen.getByTestId('cohort-comparison');
    expect(within(comparison).getByTestId('cohort-selected-A')).toBeInTheDocument();
    expect(within(comparison).queryByTestId('cohort-selected-E')).not.toBeInTheDocument();
    expect(within(comparison).queryByTestId('cohort-rest-E')).not.toBeInTheDocument();
  });

  it('copies and syncs host names from the cells, whatever the edge query calls its endpoints', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftDrag(HOST.a1, HOST.a2);
    // The label of a selection is a hierarchy label of the cells; the edge query's labels are not offered.
    expect(screen.getByTestId('selection-label')).toHaveTextContent('2 host values:');
  });
});
