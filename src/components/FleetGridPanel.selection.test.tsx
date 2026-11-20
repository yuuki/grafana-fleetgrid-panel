import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createTheme, FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, LevelDef } from '../types';
import { FleetGridPanel } from './FleetGridPanel';
import { SYNC_DELAY_MS } from './useVariableSync';

// Cell selection in the panel: the Shift gestures, what they leave untouched, the selection bar and
// the wiring of the variable sync. The pure parts (selection state, statistics, export formats,
// hostlist, region hit test) have their own tests.

const mockPartial = jest.fn();
let mockVariables: Array<{ name: string; type: string; multi?: boolean; current?: { value?: unknown } }> = [];

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelDataErrorView: () => <div>No data</div>,
  locationService: { partial: (...args: unknown[]) => mockPartial(...args) },
  getTemplateSrv: () => ({ getVariables: () => mockVariables }),
}));

// Grafana's Drawer needs ResizeObserver and IntersectionObserver, which jsdom does not have; the E2E
// tests open the real one. The stand-in keeps what matters to the panel: it renders in a portal on
// the body, outside the panel's DOM but inside its React tree. Sparkline depends on uPlot.
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
  Drawer: ({ title, subtitle, children, onClose }: any) =>
    jest.requireActual('react-dom').createPortal(
      <div role="dialog" aria-label={title}>
        <div>{subtitle}</div>
        <button onClick={onClose}>Close drawer</button>
        {children}
      </div>,
      document.body
    ),
}));

const frame = (refId: string, name: string, zone: string, host: string, value: number | null) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1000] },
      { name: 'Value', type: FieldType.number, values: [value], labels: { zone, host } },
    ],
  });

// zone-a: node-a001..003, zone-b: node-b001..002. Query B has no series for node-a003.
const power: Array<[string, string, number]> = [
  ['zone-a', 'node-a001', 10],
  ['zone-a', 'node-a002', 20],
  ['zone-a', 'node-a003', 30],
  ['zone-b', 'node-b001', 100],
  ['zone-b', 'node-b002', 200],
];
const frames = (rows = power) => [
  ...rows.map(([zone, host, value]) => frame('A', 'power', zone, host, value)),
  ...rows
    .filter(([, host]) => host !== 'node-a003')
    .map(([zone, host, value]) => frame('B', 'temp', zone, host, value / 10)),
];

// Zones stacked with a label row each, hosts in a row. At 40px cells: zone-a label y 0..16, its cells
// y 16..56 at x 0, 41, 82; zone-b label y 60..76, its cells y 76..116 at x 0, 41.
const levels: LevelDef[] = [
  { ...DEFAULT_LEVEL, label: 'zone', layout: 'vertical', showLabel: true },
  { ...DEFAULT_LEVEL, label: 'host', layout: 'flow', showLabel: false },
];
const CELL = { a1: [20, 36], a2: [61, 36], a3: [102, 36], b1: [20, 96], b2: [61, 96] } as const;
const LABEL = { a: [50, 8], b: [50, 68] } as const;

const makeProps = (series: unknown[] = frames(), options: Record<string, unknown> = {}): any => ({
  id: 1,
  width: 400,
  height: 300,
  timeZone: 'browser',
  timeRange: getDefaultTimeRange(),
  data: {
    series,
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    request: { requestId: 'Q1', targets: [{ refId: 'A' }, { refId: 'B' }] },
  },
  options: {
    levels,
    displayMode: 'single',
    // No value text: the text color of a dark cell is the color of the selection ring.
    showValues: false,
    missingColor: '#444',
    spatialAggregation: 'max',
    reduceCalc: 'lastNotNull',
    ...options,
  },
});

const container = () => document.querySelector('canvas')!.parentElement as HTMLElement;
const band = () => screen.getByTestId('selection-band');
const count = () => screen.queryByTestId('selection-count')?.textContent;

type Point = readonly [number, number];
const pointer = (point: Point, init: Record<string, unknown> = {}) => ({
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  shiftKey: true,
  clientX: point[0],
  clientY: point[1],
  ...init,
});
// A real press: the browser sends the pointer and the mouse event, and a click when it is released.
const press = (point: Point, init: Record<string, unknown> = {}) => {
  fireEvent.pointerDown(container(), pointer(point, init));
  return fireEvent.mouseDown(container(), pointer(point, init));
};
const release = (point: Point, init: Record<string, unknown> = {}) => {
  fireEvent.pointerUp(container(), pointer(point, init));
  fireEvent.click(container(), pointer(point, init));
};
const shiftClick = (point: Point) => {
  press(point);
  release(point);
};
const shiftDrag = (from: Point, to: Point) => {
  press(from);
  fireEvent.pointerMove(container(), pointer(to));
  release(to);
};

// Whether the frame on the canvas rings a cell as selected.
const maxContrast = createTheme().colors.text.maxContrast;
const ringsDrawn = () => {
  const events = (
    document.querySelector('canvas')!.getContext('2d') as unknown as {
      __getEvents(): Array<{ type: string; props: { value?: string } }>;
    }
  ).__getEvents();
  const start = events.map((e) => e.type).lastIndexOf('clearRect');
  return events.slice(start).some((e) => e.type === 'fillStyle' && e.props.value === maxContrast);
};

// jsdom has no PointerEvent, and Testing Library then fires a plain Event that drops every field
// (shiftKey, button, clientX). The gestures need them, so the tests bring a minimal PointerEvent.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? '';
  }
}
const windowWithPointerEvent = window as unknown as { PointerEvent?: unknown };
const originalPointerEvent = windowWithPointerEvent.PointerEvent;
beforeAll(() => {
  windowWithPointerEvent.PointerEvent = TestPointerEvent;
});
afterAll(() => {
  windowWithPointerEvent.PointerEvent = originalPointerEvent;
});

beforeEach(() => {
  mockPartial.mockReset();
  mockVariables = [];
});

describe('FleetGridPanel cell selection', () => {
  it('shows no selection controls and draws no ring until something is selected', () => {
    render(<FleetGridPanel {...makeProps()} />);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(band()).toHaveStyle({ display: 'none' });
    expect(ringsDrawn()).toBe(false);
  });

  it('Shift+click toggles a cell, without opening the drilldown or following a data link', () => {
    const series = frames();
    const getLinks = jest.fn(() => [{ href: 'https://example.com', title: 'X', target: '_self', origin: {} }]);
    series[0].fields[1].getLinks = getLinks as any;
    render(<FleetGridPanel {...makeProps(series)} />);

    shiftClick(CELL.a1);
    expect(count()).toBe('1 cell selected');
    expect(ringsDrawn()).toBe(true);
    expect(getLinks).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    shiftClick(CELL.a2);
    expect(count()).toBe('2 cells selected');

    // Shift+click on a selected cell takes it out again.
    shiftClick(CELL.a1);
    expect(count()).toBe('1 cell selected');
    shiftClick(CELL.a2);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(ringsDrawn()).toBe(false);
  });

  it('leaves a plain click as it was: it drills down and does not change the selection', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(CELL.a1);

    press(CELL.b1, { shiftKey: false });
    release(CELL.b1, { shiftKey: false });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    expect(count()).toBe('1 cell selected');

    // Also on empty space: it closes the popover and keeps the selection.
    press([300, 200], { shiftKey: false });
    release([300, 200], { shiftKey: false });
    expect(count()).toBe('1 cell selected');
  });

  it('keeps the layout when the selection bar appears: the grid loses height and scrolls instead', () => {
    const props = makeProps();
    // Header 32px + 120px: the two zones (116px at 40px cells) just fit.
    props.height = 152;
    render(<FleetGridPanel {...props} />);
    const canvas = document.querySelector('canvas')!;
    expect(container()).toHaveStyle({ height: '120px', overflowY: 'hidden' });
    expect(canvas).toHaveStyle({ width: '122px', height: '120px' });

    shiftClick(CELL.a1);
    // The bar takes its height from the grid's box. The cells keep their 40px and their places, so the
    // canvas is as large as before and its last rows are reached by scrolling.
    expect(container()).toHaveStyle({ height: '88px', overflowY: 'auto' });
    expect(canvas).toHaveStyle({ width: '122px', height: '116px' });
    shiftClick(CELL.b2);
    expect(count()).toBe('2 cells selected');

    fireEvent.click(screen.getByTestId('selection-clear'));
    expect(container()).toHaveStyle({ height: '120px', overflowY: 'hidden' });
  });

  it('Shift+click on empty space selects nothing and drills nowhere', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick([300, 200]);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });

  it('Shift+click on a group label toggles the cells of the group as one unit', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(LABEL.a);
    expect(count()).toBe('3 cells selected');
    // All of the group is selected: the same gesture removes it.
    shiftClick(LABEL.a);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    // Part of the group is selected: the gesture completes it.
    shiftClick(CELL.b2);
    shiftClick(LABEL.b);
    expect(count()).toBe('2 cells selected');
    shiftClick(LABEL.a);
    expect(count()).toBe('5 cells selected');
  });

  it('Shift+drag adds the cells the rectangle overlaps and shows the band while dragging', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press([50, 30]);
    expect(band()).toHaveStyle({ display: 'none' });
    fireEvent.pointerMove(container(), pointer([110, 100]));
    // From inside node-a002 to inside node-a003 and down into zone-b's second cell.
    expect(band()).toHaveStyle({ display: 'block', left: '50px', top: '30px', width: '60px', height: '70px' });
    expect(band()).toHaveTextContent('3 cells');
    // Nothing is selected before the button is released.
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    release([110, 100]);
    expect(band()).toHaveStyle({ display: 'none' });
    expect(count()).toBe('3 cells selected');
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    // A second drag adds to the selection; cells that are selected already stay selected.
    shiftDrag([10, 90], [50, 100]);
    expect(count()).toBe('4 cells selected');
    // A drag in the opposite direction selects the same.
    shiftDrag([30, 50], [5, 20]);
    expect(count()).toBe('5 cells selected');
  });

  it('counts a press that moves less than the threshold as a click', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press(CELL.a1);
    fireEvent.pointerMove(container(), pointer([CELL.a1[0] + 2, CELL.a1[1] + 2]));
    expect(band()).toHaveStyle({ display: 'none' });
    release([CELL.a1[0] + 2, CELL.a1[1] + 2]);
    expect(count()).toBe('1 cell selected');
  });

  it('reads Shift when the button goes down, not when it comes up', () => {
    render(<FleetGridPanel {...makeProps()} />);
    // Shift released during the drag: still a selection.
    press([5, 20]);
    fireEvent.pointerMove(container(), pointer([50, 50], { shiftKey: false }));
    release([50, 50], { shiftKey: false });
    expect(count()).toBe('2 cells selected');
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    // Shift pressed after the button went down: a plain click.
    press(CELL.b1, { shiftKey: false });
    release(CELL.b1);
    expect(count()).toBe('2 cells selected');
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  it('keeps the browser from extending a text selection on a Shift press only', () => {
    render(<FleetGridPanel {...makeProps()} />);
    // fireEvent returns false when the handler called preventDefault.
    expect(press(CELL.a1)).toBe(false);
    release(CELL.a1);
    expect(press(CELL.a1, { shiftKey: false })).toBe(true);
  });

  it('ignores touch and the other mouse buttons', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press(CELL.a1, { pointerType: 'touch' });
    fireEvent.pointerUp(container(), pointer(CELL.a1, { pointerType: 'touch' }));
    press(CELL.a1, { button: 2 });
    fireEvent.pointerUp(container(), pointer(CELL.a1, { button: 2 }));
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
  });

  it('abandons the drag on Escape and on a cancelled pointer, selecting nothing', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press([5, 20]);
    fireEvent.pointerMove(container(), pointer([110, 100]));
    expect(band()).toHaveStyle({ display: 'block' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(band()).toHaveStyle({ display: 'none' });
    // The button comes up later: that click still belongs to the abandoned gesture.
    release([110, 100]);
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    press([5, 20]);
    fireEvent.pointerMove(container(), pointer([110, 100]));
    fireEvent.pointerCancel(container(), pointer([110, 100]));
    expect(band()).toHaveStyle({ display: 'none' });
    expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
  });

  it('shows no hover tooltip while a Shift press is in progress', () => {
    render(<FleetGridPanel {...makeProps()} />);
    fireEvent.mouseMove(container(), { clientX: CELL.a1[0], clientY: CELL.a1[1] });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    press(CELL.a1);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseMove(container(), { clientX: CELL.a2[0], clientY: CELL.a2[1] });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    release(CELL.a2);
    fireEvent.mouseMove(container(), { clientX: CELL.a2[0], clientY: CELL.a2[1] });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('keeps the start of the band on the grid when the panel scrolls during the drag', () => {
    render(<FleetGridPanel {...makeProps()} />);
    press([5, 20]);
    fireEvent.pointerMove(container(), pointer([30, 50]));
    expect(band()).toHaveStyle({ top: '20px', height: '30px' });
    expect(band()).toHaveTextContent('1 cell');
    // The wheel scrolls the grid by 40px under a pointer that does not move.
    Object.defineProperty(container(), 'scrollTop', { configurable: true, value: 40 });
    fireEvent.scroll(container());
    expect(band()).toHaveStyle({ top: '20px', height: '70px' });
    expect(band()).toHaveTextContent('2 cells');
    release([30, 50]);
    // The rectangle reaches y = 90 in content coordinates now: zone-b's first cell is in it.
    expect(count()).toBe('2 cells selected');
  });

  it('takes a Shift+click on the pinned top label of a scrolled panel as a click on that group', () => {
    render(<FleetGridPanel {...makeProps()} />);
    // Scrolled by 30px, zone-a's label is drawn pinned over y 30..46, where its cells are laid out.
    Object.defineProperty(container(), 'scrollTop', { configurable: true, value: 30 });
    fireEvent.scroll(container());
    shiftClick([20, 5]);
    expect(count()).toBe('3 cells selected');
  });

  describe('clearing', () => {
    it('clears with the Clear button', () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.a);
      fireEvent.click(screen.getByTestId('selection-clear'));
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
      expect(ringsDrawn()).toBe(false);
    });

    it('moves the focus to the selection bar after a gesture, where Escape clears the selection', () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      expect(screen.getByTestId('selection-bar')).toHaveFocus();
      // The key press is used up: it does not reach listeners outside the panel (Grafana's shortcuts).
      const outside = jest.fn();
      document.addEventListener('keydown', outside);
      fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Escape' });
      document.removeEventListener('keydown', outside);
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
      expect(outside).not.toHaveBeenCalled();
    });

    it('does not clear on Escape pressed outside the panel, or on another key', () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Enter' });
      expect(count()).toBe('1 cell selected');
    });

    it('lets an open drilldown popover take the first Escape', () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      press(CELL.b1, { shiftKey: false });
      release(CELL.b1, { shiftKey: false });
      expect(screen.getByLabelText('Close')).toBeInTheDocument();
      fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Escape' });
      expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
      expect(count()).toBe('1 cell selected');
      fireEvent.keyDown(screen.getByTestId('selection-bar'), { key: 'Escape' });
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    });
  });

  describe('when the data or the layout changes', () => {
    it('keeps the same cells selected through a refresh, a new order and a resize', () => {
      const view = render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a2);
      shiftClick(CELL.b1);

      // New frames in reverse order, and a panel so narrow that the cells shrink and move.
      const next = makeProps(frames([...power].reverse()));
      next.width = 60;
      next.data.request.requestId = 'Q2';
      view.rerender(<FleetGridPanel {...next} />);
      expect(count()).toBe('2 cells selected');
      expect(ringsDrawn()).toBe(true);
      fireEvent.click(screen.getByTestId('selection-copy-list'));
      expect(screen.getByTestId('selection-label')).toHaveTextContent('2 host values:');
    });

    it('keeps a cell selected while it is missing from the data, and says so', () => {
      const view = render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      shiftClick(CELL.a2);

      const without = makeProps(frames(power.filter(([, host]) => host !== 'node-a002')));
      view.rerender(<FleetGridPanel {...without} />);
      expect(count()).toBe('1 cell selected (+1 not in the current data)');
      expect(screen.getByTestId('selection-label')).toHaveTextContent('1 host value:');

      // Every selected cell gone: the bar stays so the selection can be seen and cleared.
      const none = makeProps(frames(power.filter(([zone]) => zone === 'zone-b')));
      view.rerender(<FleetGridPanel {...none} />);
      expect(count()).toBe('0 cells selected (+2 not in the current data)');
      expect(screen.getByTestId('selection-compare')).toBeDisabled();
      expect(ringsDrawn()).toBe(false);

      view.rerender(<FleetGridPanel {...makeProps()} />);
      expect(count()).toBe('2 cells selected');
    });

    it('clears the selection when the hierarchy levels change, because the cell paths change meaning', () => {
      const view = render(<FleetGridPanel {...makeProps()} />);
      shiftClick(CELL.a1);
      // The same levels in a new array are no change.
      view.rerender(<FleetGridPanel {...makeProps(frames(), { levels: levels.map((l) => ({ ...l })) })} />);
      expect(count()).toBe('1 cell selected');
      view.rerender(<FleetGridPanel {...makeProps(frames(), { levels: [levels[1]] })} />);
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();
    });
  });

  describe('copying', () => {
    const writeText = jest.fn();
    const original = {
      clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
      secure: Object.getOwnPropertyDescriptor(window, 'isSecureContext'),
    };
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    });
    afterEach(() => {
      for (const [target, key, descriptor] of [
        [navigator, 'clipboard', original.clipboard],
        [window, 'isSecureContext', original.secure],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(target, key, descriptor);
        } else {
          delete (target as unknown as Record<string, unknown>)[key];
        }
      }
    });
    const copy = async (format: string) => {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`selection-copy-${format}`));
      });
      return writeText.mock.calls[writeText.mock.calls.length - 1]?.[0];
    };

    it('copies the selected host names as a regular expression, a list and a hostlist', async () => {
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.a);
      shiftClick(CELL.b2);
      expect(screen.getByTestId('selection-label')).toHaveTextContent('4 host values:');
      expect(await copy('regex')).toBe('^(node-a001|node-a002|node-a003|node-b002)$');
      expect(await copy('list')).toBe('node-a001,node-a002,node-a003,node-b002');
      expect(await copy('hostlist')).toBe('node-a[001-003],node-b002');
    });

    it('copies the values of the configured selection label', async () => {
      render(<FleetGridPanel {...makeProps(frames(), { selectionLabel: 'zone' })} />);
      shiftClick(CELL.a1);
      shiftClick(CELL.b1);
      expect(screen.getByTestId('selection-label')).toHaveTextContent('2 zone values:');
      expect(await copy('list')).toBe('zone-a,zone-b');
    });

    it('shows the text to copy by hand when the browser refuses', async () => {
      writeText.mockRejectedValue(new Error('NotAllowedError'));
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.b);
      await copy('hostlist');
      const alert = within(screen.getByTestId('selection-bar')).getByRole('alert');
      expect(alert).toHaveTextContent('did not allow copying');
      expect(within(alert).getByRole('textbox')).toHaveValue('node-b[001-002]');
      // A copy that works afterwards removes the notice.
      writeText.mockResolvedValue(undefined);
      await copy('list');
      expect(within(screen.getByTestId('selection-bar')).queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('opens the cohort comparison of the selected cells against the others', () => {
    render(<FleetGridPanel {...makeProps()} />);
    shiftClick(LABEL.b);
    fireEvent.click(screen.getByTestId('selection-compare'));
    const comparison = screen.getByTestId('cohort-comparison');
    expect(screen.getByText('2 selected cells against 3 other cells')).toBeInTheDocument();
    // power: 100, 200 against 10, 20, 30. Every selected cell is higher.
    const cells = (testId: string) =>
      within(within(comparison).getByTestId(testId))
        .getAllByRole('cell')
        .map((cell) => cell.textContent);
    expect(cells('cohort-selected-A')).toEqual(['2', '0', '100', '150', '195', '200', '+1.00']);
    expect(cells('cohort-rest-A')).toEqual(['3', '0', '10', '20', '29', '30']);
    // temp has no series for node-a003: one of the others has no value, and is not counted as 0.
    expect(cells('cohort-rest-B')).toEqual(['2', '1', '1', '1.50', '1.95', '2']);
    expect(within(comparison).getByTestId('cohort-delta-B')).toHaveTextContent('+1.00');

    // A click inside the drawer, which React bubbles to the panel through the portal, is not a cell click,
    // and Escape inside it does not clear the selection.
    fireEvent.click(comparison);
    fireEvent.keyDown(comparison, { key: 'Escape' });
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
    expect(count()).toBe('2 cells selected');
    fireEvent.click(screen.getByText('Close drawer'));
    expect(screen.queryByTestId('cohort-comparison')).not.toBeInTheDocument();
  });

  describe('variable sync', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    const wait = () => act(() => jest.advanceTimersByTime(SYNC_DELAY_MS));

    it('writes nothing unless a variable is configured', () => {
      mockVariables = [{ name: 'hosts', type: 'custom', multi: true, current: { value: '$__all' } }];
      render(<FleetGridPanel {...makeProps()} />);
      shiftClick(LABEL.a);
      wait();
      expect(mockPartial).not.toHaveBeenCalled();
      expect(screen.queryByTestId('selection-sync')).not.toBeInTheDocument();
    });

    it('writes the selected hosts once the selection has settled, and restores the variable when it is cleared', () => {
      mockVariables = [{ name: 'hosts', type: 'custom', multi: true, current: { value: '$__all' } }];
      mockPartial.mockImplementation((query: Record<string, unknown>) => {
        mockVariables[0].current = { value: query['var-hosts'] };
      });
      render(<FleetGridPanel {...makeProps(frames(), { selectionVariable: '$hosts' })} />);
      // Three quick gestures are one write.
      shiftClick(CELL.a1);
      shiftClick(CELL.a2);
      shiftClick(CELL.b1);
      expect(mockPartial).not.toHaveBeenCalled();
      wait();
      expect(mockPartial).toHaveBeenCalledTimes(1);
      expect(mockPartial).toHaveBeenCalledWith({ 'var-hosts': ['node-a001', 'node-a002', 'node-b001'] }, true);
      expect(screen.getByTestId('selection-sync')).toHaveTextContent('→ $hosts');

      fireEvent.click(screen.getByTestId('selection-clear'));
      wait();
      expect(mockPartial).toHaveBeenLastCalledWith({ 'var-hosts': '$__all' }, true);
      expect(mockPartial).toHaveBeenCalledTimes(2);
    });

    it('does not write again when the data refreshes with the same cells', () => {
      mockVariables = [{ name: 'hosts', type: 'textbox', current: { value: '.*' } }];
      const view = render(<FleetGridPanel {...makeProps(frames(), { selectionVariable: 'hosts' })} />);
      shiftClick(CELL.a1);
      wait();
      expect(mockPartial).toHaveBeenCalledWith({ 'var-hosts': '^(node-a001)$' }, true);
      const next = makeProps(frames(), { selectionVariable: 'hosts' });
      next.data.request.requestId = 'Q2';
      view.rerender(<FleetGridPanel {...next} />);
      wait();
      expect(mockPartial).toHaveBeenCalledTimes(1);
    });

    it('says so when Grafana refuses the write, and writes nothing after the panel is gone', () => {
      mockVariables = [{ name: 'hosts', type: 'custom', multi: true, current: { value: '$__all' } }];
      mockPartial.mockImplementation(() => {
        throw new Error('URI malformed');
      });
      const view = render(<FleetGridPanel {...makeProps(frames(), { selectionVariable: 'hosts' })} />);
      shiftClick(CELL.a1);
      wait();
      expect(screen.getByTestId('selection-sync')).toHaveTextContent('Could not set $hosts');

      // Nothing was written, so there is nothing to put back when the panel goes away, and the write
      // that was still waiting is dropped.
      mockPartial.mockReset();
      shiftClick(CELL.a2);
      view.unmount();
      wait();
      expect(mockPartial).not.toHaveBeenCalled();
    });

    it('restores the variable when the panel unmounts on the same page, and not on another page', () => {
      const variables = () => [{ name: 'hosts', type: 'custom', multi: true, current: { value: '$__all' as unknown } }];
      mockPartial.mockImplementation((query: Record<string, unknown>) => {
        mockVariables[0].current = { value: query['var-hosts'] };
      });
      const select = () => {
        mockVariables = variables();
        const view = render(<FleetGridPanel {...makeProps(frames(), { selectionVariable: 'hosts' })} />);
        shiftClick(CELL.a1);
        wait();
        expect(mockPartial).toHaveBeenLastCalledWith({ 'var-hosts': ['node-a001'] }, true);
        return view;
      };

      // Grafana remounts the panel for the panel view or the editor: the selection is gone, so is its filter.
      select().unmount();
      expect(mockPartial).toHaveBeenLastCalledWith({ 'var-hosts': '$__all' }, true);

      // The user went to another dashboard: its URL is not touched.
      const view = select();
      const calls = mockPartial.mock.calls.length;
      window.history.pushState({}, '', '/d/other/dashboard');
      try {
        view.unmount();
        expect(mockPartial).toHaveBeenCalledTimes(calls);
      } finally {
        window.history.pushState({}, '', '/');
      }
    });

    it('says in the selection bar when the variable does not exist', () => {
      render(<FleetGridPanel {...makeProps(frames(), { selectionVariable: 'hosts' })} />);
      shiftClick(CELL.a1);
      wait();
      expect(mockPartial).not.toHaveBeenCalled();
      expect(screen.getByTestId('selection-sync')).toHaveTextContent('Variable "hosts" is not in this dashboard');
    });
  });
});
