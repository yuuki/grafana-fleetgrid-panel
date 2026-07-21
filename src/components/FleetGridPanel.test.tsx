import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL } from '../types';
import { FleetGridPanel } from './FleetGridPanel';
import { fetchDrilldownFrames } from '../drilldown/requery';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelDataErrorView: () => <div>No data</div>,
}));

// Mock the requery to verify the wiring (instant detection / stale guard / cache)
jest.mock('../drilldown/requery', () => ({
  fetchDrilldownFrames: jest.fn(),
}));

// Replace Sparkline with a test placeholder since it depends on uPlot (only check whether it renders)
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
}));

const mockFetch = fetchDrilldownFrames as jest.Mock;

const series = (refId: string, name: string, zone: string) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1000] },
      { name: 'Value', type: FieldType.number, values: [1], labels: { zone } },
    ],
  });

const makeProps = (frames: unknown[]): any => ({
  id: 1,
  width: 400,
  height: 300,
  timeZone: 'browser',
  timeRange: getDefaultTimeRange(),
  data: {
    series: frames,
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    request: { requestId: 'Q1', targets: (frames as Array<{ refId: string }>).map((f) => ({ refId: f.refId })) },
  },
  options: {
    levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
    displayMode: 'single',
    showValues: true,
    missingColor: '#444',
    spatialAggregation: 'max',
    reduceCalc: 'lastNotNull',
  },
});

describe('FleetGridPanel', () => {
  it('renders canvas and a metric selector for multiple queries', () => {
    render(<FleetGridPanel {...makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')])} />);
    expect(document.querySelector('canvas')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('always shows a range legend and reserves the measured header height for a single query', () => {
    render(<FleetGridPanel {...makeProps([series('A', 'power', 'zone-a')])} />);
    expect(screen.getByLabelText(/power range, Auto/)).toBeInTheDocument();
    expect(document.querySelector('canvas')!.parentElement).toHaveStyle({ height: '268px' });
  });

  it('clamps the scroll container height to zero when the panel is shorter than its header', () => {
    const p = makeProps([series('A', 'power', 'zone-a')]);
    p.height = 20;
    render(<FleetGridPanel {...p} />);
    expect(document.querySelector('canvas')!.parentElement).toHaveStyle({ height: '0px' });
  });

  it('uses a measured wrapped header height when sizing the scroll container', () => {
    const originalResizeObserver = global.ResizeObserver;
    const observers: MockResizeObserver[] = [];
    class MockResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();

      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
    }
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    try {
      render(<FleetGridPanel {...makeProps([series('A', 'power', 'zone-a')])} />);
      const header = screen.getByTestId('range-legend').parentElement as HTMLElement;
      Object.defineProperty(header, 'offsetHeight', { configurable: true, value: 48 });
      const headerObserver = observers.find((observer) => observer.observe.mock.calls[0]?.[0] === header);
      act(() => headerObserver?.callback([], headerObserver as unknown as ResizeObserver));
      expect(document.querySelector('canvas')!.parentElement).toHaveStyle({ height: '252px' });
    } finally {
      global.ResizeObserver = originalResizeObserver;
    }
  });

  it('updates the single-mode range legend when the selected metric changes', () => {
    render(<FleetGridPanel {...makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')])} />);
    expect(screen.getByLabelText(/power range, Auto/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'temp' }));
    expect(screen.getByLabelText(/temp range, Auto/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/power range, Auto/)).not.toBeInTheDocument();
  });

  it('shows warnings when the hierarchy label is absent', () => {
    const p = makeProps([series('A', 'power', 'zone-a')]);
    p.options.levels = [{ ...DEFAULT_LEVEL, label: 'rack' }];
    render(<FleetGridPanel {...p} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows no-data view when there are no frames', () => {
    render(<FleetGridPanel {...makeProps([])} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('shows the metric selector when displayMode is unset (defaults to single)', () => {
    const p = makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')]);
    delete p.options.displayMode;
    render(<FleetGridPanel {...p} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('shows the split legend and hides the single-mode selector in split mode', () => {
    const p = makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')]);
    p.options.displayMode = 'split';
    render(<FleetGridPanel {...p} />);
    expect(screen.getByText('1: power')).toBeInTheDocument(); // Legend (zone-position miniature + number:name)
    expect(screen.getByText('2: temp')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument(); // Don't show the selector in single mode
  });

  it('uses content coordinates (incl. scrollLeft) for hover hit testing', () => {
    // Same refId, 2 zones side by side as 2 cells (flow, s=40 → zone-a:[0,40), zone-b:[41,81)). No header since there's only one refId.
    render(<FleetGridPanel {...makeProps([series('A', 'power', 'zone-a'), series('A', 'power', 'zone-b')])} />);
    const container = document.querySelector('canvas')!.parentElement as HTMLElement;
    // Reproduce a horizontally scrolled state (scrollLeft=50)
    Object.defineProperty(container, 'scrollLeft', { configurable: true, value: 50 });
    // clientX=10 would naively be zone-a([0,40)), but with +scrollLeft=50, cx=60 → zone-b([41,81)) is the correct hit
    fireEvent.mouseMove(container, { clientX: 10, clientY: 5 });
    const title = screen.getByText('zone-b'); // The correct cell accounting for scrollLeft is hit
    expect(title).toBeInTheDocument();
    expect(title.parentElement).toHaveStyle({ left: '72px' }); // tooltip x = cx(60) + 12 = content coordinates
  });

  it('lists refIds for configured queries that returned no series', () => {
    const p = makeProps([series('A', 'power', 'zone-a')]);
    // Query B is configured (targets) but has 0 series (not present in series)
    p.data.request.targets = [{ refId: 'A' }, { refId: 'B' }];
    render(<FleetGridPanel {...p} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('power')).toBeInTheDocument(); // A is the series name
    expect(screen.getByText('B')).toBeInTheDocument(); // B has no metricInfo, so the refId is displayed
  });

  it.each([400, 500])('keeps a no-data range legend visible when a zero-series query is selected at %ipx', (width) => {
    const p = makeProps([series('A', 'power', 'zone-a')]);
    p.width = width;
    p.data.request.targets = [{ refId: 'A' }, { refId: 'B' }];
    render(<FleetGridPanel {...p} />);
    if (width < 480) {
      expect(screen.getByLabelText(/power range, Auto/)).toBeInTheDocument();
    } else {
      expect(screen.getByText('Auto')).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('radio', { name: 'B' }));

    expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    expect(screen.getByLabelText('B range, No data')).toHaveTextContent('B');
    expect(screen.getByLabelText('B range, No data')).toHaveTextContent('No data');
  });

  it('shows a warning banner while still rendering cells when only some rows match', () => {
    const twoLevel = (zone: string, gpu?: string) =>
      toDataFrame({
        refId: 'A',
        name: 'power',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000] },
          { name: 'Value', type: FieldType.number, values: [1], labels: gpu ? { zone, gpu } : { zone } },
        ],
      });
    const p = makeProps([twoLevel('zone-a', '0'), twoLevel('zone-b')]); // The second one is missing gpu → excluded
    p.options.levels = [{ ...DEFAULT_LEVEL, label: 'zone' }, { ...DEFAULT_LEVEL, label: 'gpu' }];
    render(<FleetGridPanel {...p} />);
    expect(document.querySelector('canvas')).toBeInTheDocument(); // The matching row's cell is rendered
    expect(screen.getByRole('alert')).toBeInTheDocument(); // and the warning banner is also shown at the same time
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();
  });

  it('shows an explicit data error when queries return no numeric cells (not a silent empty canvas)', () => {
    const stringOnly = toDataFrame({
      refId: 'A',
      fields: [{ name: 'zone', type: FieldType.string, values: ['zone-a'] }], // No numeric field
    });
    render(<FleetGridPanel {...makeProps([stringOnly])} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/numeric cells/)).toBeInTheDocument();
    expect(document.querySelector('canvas')).not.toBeInTheDocument();
  });

  // A frame with 2 side-by-side cells (zone-a:[0,40)). clientX=10 hits zone-a.
  const clickable = () => [series('A', 'power', 'zone-a'), series('A', 'power', 'zone-b')];
  const containerOf = () => document.querySelector('canvas')!.parentElement as HTMLElement;

  it('follows a single data link (onClick preserved) and suppresses the popover', () => {
    const onLinkClick = jest.fn();
    const frames = clickable();
    frames[0].fields[1].getLinks = (() => [
      { href: 'https://example.com/d/x', title: 'X', target: '_self', origin: {}, onClick: onLinkClick },
    ]) as any;
    render(<FleetGridPanel {...makeProps(frames)} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(onLinkClick).toHaveBeenCalled(); // Data Links take priority and execute immediately
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument(); // The popover is suppressed
  });

  it('shows a selection menu for multiple data links (not the popover)', () => {
    const frames = clickable();
    frames[0].fields[1].getLinks = (() => [
      { href: 'https://example.com/a', title: 'Link A', target: '_blank', origin: {} },
      { href: 'https://example.com/b', title: 'Link B', target: '_blank', origin: {} },
    ]) as any;
    render(<FleetGridPanel {...makeProps(frames)} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(screen.getByText('Link A')).toBeInTheDocument();
    expect(screen.getByText('Link B')).toBeInTheDocument();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });

  it('renders the link menu with theme colors (not a hardcoded dark background) and a bounded position', () => {
    const frames = clickable();
    frames[0].fields[1].getLinks = (() => [
      { href: 'https://example.com/a', title: 'Link A', target: '_blank', origin: {} },
      { href: 'https://example.com/b', title: 'Link B', target: '_blank', origin: {} },
    ]) as any;
    render(<FleetGridPanel {...makeProps(frames)} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    const menu = screen.getByRole('menu');
    // Use theme-derived colors instead of the old implementation's fixed dark color (readable in light theme too)
    expect(menu.style.background).not.toBe('rgba(24,27,31,0.98)');
    expect(menu.style.background).toBeTruthy();
    // Position is numeric and within the clamp range (top-left is >= 0)
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
  });

  // Override the container's actual visible inner size and scroll amount (set explicitly since jsdom doesn't perform layout)
  const setBox = (el: HTMLElement, box: { sl?: number; st?: number; cw: number; ch: number }) => {
    Object.defineProperty(el, 'scrollLeft', { configurable: true, value: box.sl ?? 0 });
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: box.st ?? 0 });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: box.cw });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.ch });
  };
  const linksOf = (n: number) =>
    (() => Array.from({ length: n }, (_, i) => ({ href: `https://l/${i}`, title: `L${i}`, target: '_blank', origin: {} }))) as any;

  it('places the link menu in content coordinates using the scroll offset', () => {
    const frames = clickable();
    frames[1].fields[1].getLinks = linksOf(2); // 2 links on the zone-b cell
    render(<FleetGridPanel {...makeProps(frames)} />);
    const container = containerOf();
    setBox(container, { sl: 50, cw: 400, ch: 300 });
    // clientX=10 + scrollLeft=50 → cx=60 (hits zone-b including horizontal scroll)
    fireEvent.click(container, { clientX: 10, clientY: 5 });
    const menu = screen.getByRole('menu');
    expect(parseFloat(menu.style.left)).toBe(68); // cx(60)+8, content coordinates (including scrollLeft)
    expect(parseFloat(menu.style.top)).toBe(13); // cy(5)+8
  });

  it('flips and clamps the link menu within the real inner width (excludes scrollbar area)', () => {
    const frames = clickable();
    frames[1].fields[1].getLinks = linksOf(2);
    render(<FleetGridPanel {...makeProps(frames)} />);
    const container = containerOf();
    // Make the actual visible inner size 300, narrower than props.width(400). Using width would overflow the right edge.
    setBox(container, { cw: 300, ch: 300 });
    fireEvent.click(container, { clientX: 60, clientY: 5 }); // cx=60(zone-b)
    const menu = screen.getByRole('menu');
    const left = parseFloat(menu.style.left);
    expect(menu.style.width).toBe('240px');
    expect(menu.style.paddingLeft).toBe('4px');
    expect(menu.style.paddingRight).toBe('4px');
    expect(menu.style.borderLeftWidth).toBe('1px');
    expect(menu.style.borderRightWidth).toBe('1px');
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + 240).toBeLessThanOrEqual(300); // Fits within the actual visible inner size (based on clientWidth)
    expect(left).toBeLessThan(60); // Flipped to the left of the click position
  });

  it('shrinks the link menu to fit a visible width below 240px', () => {
    const frames = clickable();
    frames[1].fields[1].getLinks = linksOf(2);
    render(<FleetGridPanel {...makeProps(frames)} />);
    const container = containerOf();
    setBox(container, { cw: 180, ch: 300 });
    fireEvent.click(container, { clientX: 60, clientY: 5 });
    const menu = screen.getByRole('menu');
    const menuWidth = parseFloat(menu.style.width);
    const right = parseFloat(menu.style.left) + menuWidth;
    expect(menuWidth).toBe(180);
    expect(right).toBeLessThanOrEqual(180);
  });

  it.each([0, 1, 5, 9])('avoids fractional horizontal chrome below 10px at a %dpx visible width', (visibleWidth) => {
    const frames = clickable();
    frames[1].fields[1].getLinks = linksOf(2);
    render(<FleetGridPanel {...makeProps(frames)} />);
    const container = containerOf();
    setBox(container, { sl: 50, cw: visibleWidth, ch: 300 });
    fireEvent.click(container, { clientX: 10, clientY: 5 });
    const menu = screen.getByRole('menu');
    const menuWidth = parseFloat(menu.style.width);
    const horizontalChrome =
      parseFloat(menu.style.paddingLeft) +
      parseFloat(menu.style.paddingRight) +
      parseFloat(menu.style.borderLeftWidth) +
      parseFloat(menu.style.borderRightWidth);
    const minimumOuterWidth = Math.max(menuWidth, horizontalChrome);
    expect(menuWidth).toBe(visibleWidth);
    expect(parseFloat(menu.style.paddingLeft)).toBe(0);
    expect(parseFloat(menu.style.paddingRight)).toBe(0);
    expect(parseFloat(menu.style.borderLeftWidth)).toBe(0);
    expect(parseFloat(menu.style.borderRightWidth)).toBe(0);
    expect(horizontalChrome).toBeLessThanOrEqual(menuWidth);
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(50);
    expect(parseFloat(menu.style.left) + minimumOuterWidth).toBeLessThanOrEqual(50 + visibleWidth);
  });

  it('repositions an open link menu within the resized visible bounds', () => {
    const frames = clickable();
    frames[1].fields[1].getLinks = linksOf(2);
    const props = makeProps(frames);
    const { rerender } = render(<FleetGridPanel {...props} />);
    const container = containerOf();
    setBox(container, { cw: 400, ch: 300 });
    fireEvent.click(container, { clientX: 60, clientY: 5 });
    const menu = screen.getByRole('menu');
    expect(parseFloat(menu.style.left)).toBe(68);

    setBox(container, { cw: 300, ch: 180 });
    rerender(<FleetGridPanel {...props} width={300} height={180} />);

    expect(screen.getByRole('menu')).toBe(menu);
    expect(parseFloat(menu.style.left)).toBeLessThan(68);
    expect(parseFloat(menu.style.left) + 240).toBeLessThanOrEqual(300);
  });

  it('observes a replacement scroll container after an early return', () => {
    const originalResizeObserver = global.ResizeObserver;
    const observers: MockResizeObserver[] = [];
    class MockResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();

      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
    }
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

    try {
      const frames = clickable();
      frames[1].fields[1].getLinks = linksOf(2);
      const props = makeProps(frames);
      const { rerender } = render(<FleetGridPanel {...props} />);
      const oldContainer = containerOf();
      setBox(oldContainer, { cw: 400, ch: 300 });

      rerender(<FleetGridPanel {...makeProps([])} />);
      rerender(<FleetGridPanel {...props} />);
      const newContainer = containerOf();
      expect(newContainer).not.toBe(oldContainer);
      setBox(newContainer, { cw: 400, ch: 300 });
      fireEvent.click(newContainer, { clientX: 60, clientY: 5 });
      const menu = screen.getByRole('menu');
      expect(parseFloat(menu.style.left)).toBe(68);

      setBox(newContainer, { cw: 300, ch: 180 });
      act(() => {
        observers.forEach((observer) => observer.callback([], observer as unknown as ResizeObserver));
      });

      expect(parseFloat(menu.style.left)).toBeLessThan(68);
      expect(parseFloat(menu.style.left) + 240).toBeLessThanOrEqual(300);
      const oldContainerObserver = observers.find((observer) => observer.observe.mock.calls[0]?.[0] === oldContainer);
      const newContainerObserver = observers.find((observer) => observer.observe.mock.calls[0]?.[0] === newContainer);
      expect(oldContainerObserver?.disconnect).toHaveBeenCalled();
      expect(newContainerObserver?.observe).toHaveBeenCalledWith(newContainer);
    } finally {
      global.ResizeObserver = originalResizeObserver;
    }
  });

  it('caps a tall link menu to the visible height and enables internal scroll', () => {
    const frames = clickable();
    frames[0].fields[1].getLinks = linksOf(12); // A tall menu
    render(<FleetGridPanel {...makeProps(frames)} />);
    const container = containerOf();
    setBox(container, { cw: 400, ch: 100 }); // Taller than the visible height of 100px
    fireEvent.click(container, { clientX: 10, clientY: 5 }); // cx=10(zone-a)
    const menu = screen.getByRole('menu');
    expect(menu.style.maxHeight).toBe('100px'); // Clamped to the visible height
    expect(menu.style.overflowY).toBe('auto'); // Internal scroll
    expect(parseFloat(menu.style.top) + 100).toBeLessThanOrEqual(100); // The bottom edge is within the visible range
  });

  it('collects data links across colliding label sets when a cell is clicked', () => {
    // node-a017 and node-b017 collapse into the same "017" cell via trailingNumber.
    // The click wiring (getCellLinks(..., cell.labelSets)) collects links from both sets and shows a selection menu.
    const mk = (host: string, href: string) => {
      const f = toDataFrame({
        refId: 'A',
        name: 'power',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000] },
          { name: 'Value', type: FieldType.number, values: [1], labels: { host } },
        ],
      });
      f.fields[1].getLinks = (() => [{ href, title: href, target: '_blank', origin: {} }]) as any;
      return f;
    };
    const p = makeProps([mk('node-a017', 'https://a'), mk('node-b017', 'https://b')]);
    p.options.levels = [{ ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' }];
    render(<FleetGridPanel {...p} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('https://a')).toBeInTheDocument();
    expect(screen.getByText('https://b')).toBeInTheDocument();
  });

  it('opens the drilldown popover when there are no data links, then closes it on Escape', () => {
    render(<FleetGridPanel {...makeProps(clickable())} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });

  it('repositions an open drilldown popover within the resized visible bounds', () => {
    const props = makeProps(clickable());
    const { rerender } = render(<FleetGridPanel {...props} />);
    const container = containerOf();
    setBox(container, { cw: 400, ch: 300 });
    fireEvent.click(container, { clientX: 60, clientY: 5 });
    const close = screen.getByLabelText('Close');
    const popover = close.parentElement!.parentElement as HTMLElement;
    expect(parseFloat(popover.style.left)).toBe(68);
    expect(parseFloat(popover.style.top)).toBe(13);

    setBox(container, { cw: 320, ch: 80 });
    rerender(<FleetGridPanel {...props} width={320} height={80} />);

    expect(screen.getByLabelText('Close')).toBe(close);
    expect(parseFloat(popover.style.left)).toBeLessThan(68);
    expect(parseFloat(popover.style.left) + 300).toBeLessThanOrEqual(320);
    expect(parseFloat(popover.style.top)).toBeLessThan(13);
    expect(parseFloat(popover.style.top) + 74).toBeLessThanOrEqual(80);
  });

  it('closes the popover on an outside pointerdown', () => {
    render(<FleetGridPanel {...makeProps(clickable())} />);
    fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });

  it('closes the popover on scroll', () => {
    render(<FleetGridPanel {...makeProps(clickable())} />);
    const container = containerOf();
    fireEvent.click(container, { clientX: 10, clientY: 5 });
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
    fireEvent.scroll(container);
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });

  describe('on-demand requery for instant queries', () => {
    beforeEach(() => mockFetch.mockReset());

    const sparkFrame = (v: number) =>
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000, 2000] },
          { name: 'Value', type: FieldType.number, values: [v, v + 1], labels: { zone: 'zone-a' } },
        ],
      });

    it('does not requery when the panel data has no instant targets (range-only)', () => {
      // makeProps's targets have no instant flag (range-only), so no requery runs
      render(<FleetGridPanel {...makeProps(clickable())} />);
      fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
      expect(screen.getByLabelText('Close')).toBeInTheDocument(); // The popover opens
      expect(mockFetch).not.toHaveBeenCalled(); // range-only → no requery
    });

    it('requeries once for instant queries and discards a stale response after the requestId changes', async () => {
      let resolve1!: (v: unknown) => void;
      let resolve2!: (v: unknown) => void;
      mockFetch
        .mockReturnValueOnce(new Promise((r) => (resolve1 = r)))
        .mockReturnValueOnce(new Promise((r) => (resolve2 = r)));

      const instantTargets = [{ refId: 'A', instant: true }];
      const p1 = makeProps(clickable());
      p1.data.request.targets = instantTargets;
      const { rerender } = render(<FleetGridPanel {...p1} />);
      fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
      // With instant and no time series on hand → requery starts, showing loading state
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Loading…')).toBeInTheDocument();

      // requestId is updated to Q2 (panel data update)
      const p2 = makeProps(clickable());
      p2.data.request.requestId = 'Q2';
      p2.data.request.targets = instantTargets;
      await act(async () => {
        rerender(<FleetGridPanel {...p2} />);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2); // A requery runs with the new requestId

      // The old Q1 response arrives late → discarded by the stale guard, not reflected
      await act(async () => {
        resolve1([sparkFrame(90)]);
      });
      expect(screen.getByText('Loading…')).toBeInTheDocument(); // Still loading (Q1 was discarded)
      expect(screen.queryByTestId('sparkline')).not.toBeInTheDocument();

      // The new Q2 response arrives → this one is reflected and the sparkline appears
      await act(async () => {
        resolve2([sparkFrame(1)]);
      });
      expect(screen.getByTestId('sparkline')).toBeInTheDocument();
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });

    it('discards a stale rejection so a later empty-but-successful requery shows No time series, not an error', async () => {
      // Reject Q1 (stale), and succeed Q2 with "an empty frame containing no time series."
      // This lets us distinguish, in the final state after loading/sparkline has disappeared, between guard-present = "No time series" / guard-absent = "Failed to load time series".
      let reject1!: (e: unknown) => void;
      let resolve2!: (v: unknown) => void;
      mockFetch
        .mockReturnValueOnce(new Promise((_, r) => (reject1 = r)))
        .mockReturnValueOnce(new Promise((r) => (resolve2 = r)));

      const instantTargets = [{ refId: 'A', instant: true }];
      const p1 = makeProps(clickable());
      p1.data.request.targets = instantTargets;
      const { rerender } = render(<FleetGridPanel {...p1} />);
      fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Loading…')).toBeInTheDocument();

      // requestId updates to Q2 → generation advances
      const p2 = makeProps(clickable());
      p2.data.request.requestId = 'Q2';
      p2.data.request.targets = instantTargets;
      await act(async () => {
        rerender(<FleetGridPanel {...p2} />);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Q1's failure arrives late. Without the guard, setDrillError(true) would run and "Failed to load time series" would remain even after Q2 succeeds.
      await act(async () => {
        reject1(new Error('boom'));
      });

      // Q2 succeeds with an empty frame (refId mismatch = no matching series) → loading clears, drillFrames is set, no sparkline appears
      await act(async () => {
        resolve2([toDataFrame({ refId: 'ZZ', fields: [{ name: 'Value', type: FieldType.number, values: [] }] })]);
      });
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      expect(screen.queryByTestId('sparkline')).not.toBeInTheDocument();
      // If the guard is effective, drillError stays false → "No time series". If it leaked through, "Failed to load time series".
      expect(screen.getAllByText('No time series').length).toBeGreaterThan(0);
      expect(screen.queryByText('Failed to load time series')).not.toBeInTheDocument();
    });

    it('shows a failure message when the current instant re-query rejects', async () => {
      let reject1!: (e: unknown) => void;
      mockFetch.mockReturnValueOnce(new Promise((_, r) => (reject1 = r)));
      const p = makeProps(clickable());
      p.data.request.targets = [{ refId: 'A', instant: true }];
      render(<FleetGridPanel {...p} />);
      fireEvent.click(containerOf(), { clientX: 10, clientY: 5 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        reject1(new Error('boom'));
      });
      expect(screen.getByText('Failed to load time series')).toBeInTheDocument();
    });
  });
});
