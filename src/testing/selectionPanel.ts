import { fireEvent } from '@testing-library/react';
import { createTheme, FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, LevelDef } from '../types';

// Test-only fixture for the cell selection tests of FleetGridPanel: a small two-zone grid, the props
// to render it, and the Shift gestures as a browser sends them. Nothing in the plugin bundle imports
// it: webpack only follows imports from src/module.ts.

export const frame = (refId: string, name: string, zone: string, host: string, value: number | null) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1000] },
      { name: 'Value', type: FieldType.number, values: [value], labels: { zone, host } },
    ],
  });

/** zone-a: node-a001..003, zone-b: node-b001..002. */
export const power: Array<[string, string, number]> = [
  ['zone-a', 'node-a001', 10],
  ['zone-a', 'node-a002', 20],
  ['zone-a', 'node-a003', 30],
  ['zone-b', 'node-b001', 100],
  ['zone-b', 'node-b002', 200],
];

/** Query A (power) for every row, query B (temp) for every row but node-a003. */
export const frames = (rows = power) => [
  ...rows.map(([zone, host, value]) => frame('A', 'power', zone, host, value)),
  ...rows
    .filter(([, host]) => host !== 'node-a003')
    .map(([zone, host, value]) => frame('B', 'temp', zone, host, value / 10)),
];

// Zones stacked with a label row each, hosts in a row. At 40px cells: zone-a label y 0..16, its cells
// y 16..56 at x 0, 41, 82; zone-b label y 60..76, its cells y 76..116 at x 0, 41.
export const levels: LevelDef[] = [
  { ...DEFAULT_LEVEL, label: 'zone', layout: 'vertical', showLabel: true },
  { ...DEFAULT_LEVEL, label: 'host', layout: 'flow', showLabel: false },
];
export const CELL = { a1: [20, 36], a2: [61, 36], a3: [102, 36], b1: [20, 96], b2: [61, 96] } as const;
export const LABEL = { a: [50, 8], b: [50, 68] } as const;

export const makeProps = (series: unknown[] = frames(), options: Record<string, unknown> = {}): any => ({
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

export type Point = readonly [number, number];

const pointer = (point: Point, init: Record<string, unknown> = {}) => ({
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  shiftKey: true,
  clientX: point[0],
  clientY: point[1],
  ...init,
});

const maxContrast = createTheme().colors.text.maxContrast;

/** The parts of one rendered panel and the gestures on it. `root` tells two panels of one test apart. */
export function panelUi(root: ParentNode = document) {
  const find = (testId: string) => root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const container = () => root.querySelector('canvas')!.parentElement as HTMLElement;
  // A real press: the browser sends the pointer and the mouse event, and a click when it is released.
  const press = (point: Point, init: Record<string, unknown> = {}) => {
    fireEvent.pointerDown(container(), pointer(point, init));
    return fireEvent.mouseDown(container(), pointer(point, init));
  };
  const release = (point: Point, init: Record<string, unknown> = {}) => {
    fireEvent.pointerUp(container(), pointer(point, init));
    fireEvent.click(container(), pointer(point, init));
  };
  return {
    find,
    container,
    band: () => find('selection-band')!,
    /** The text of the selection count, undefined while nothing is selected. */
    count: () => find('selection-count')?.textContent,
    /** The text about the exported label and its values. */
    label: () => find('selection-label')?.textContent,
    /** The text about the variable sync, undefined when the bar says nothing about it. */
    sync: () => find('selection-sync')?.textContent,
    clear: () => fireEvent.click(find('selection-clear')!),
    pointer,
    press,
    release,
    shiftClick: (point: Point) => {
      press(point);
      release(point);
    },
    shiftDrag: (from: Point, to: Point) => {
      press(from);
      fireEvent.pointerMove(container(), pointer(to));
      release(to);
    },
    /** Whether the frame on the canvas rings a cell as selected. */
    ringsDrawn: () => {
      const events = (
        root.querySelector('canvas')!.getContext('2d') as unknown as {
          __getEvents(): Array<{ type: string; props: { value?: string } }>;
        }
      ).__getEvents();
      const start = events.map((e) => e.type).lastIndexOf('clearRect');
      return events.slice(start).some((e) => e.type === 'fillStyle' && e.props.value === maxContrast);
    },
  };
}

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

/** Installs the minimal PointerEvent for the tests of the calling file. */
export function installPointerEvent(): void {
  const target = window as unknown as { PointerEvent?: unknown };
  const original = target.PointerEvent;
  beforeAll(() => {
    target.PointerEvent = TestPointerEvent;
  });
  afterAll(() => {
    target.PointerEvent = original;
  });
}
