import { createTheme } from '@grafana/data';
import { FlowEdge } from '../data/edges';
import { LayoutResult } from '../layout/layout';
import { FlowRect } from './flowGeometry';
import { FlowRenderContext, flowArrowSize, flowBadgeText, flowLineWidth, renderFlowOverlay } from './flowRenderer';
import { renderCanvas } from './renderer';

const theme = createTheme();
const BACKGROUND = theme.colors.background.primary;
const NEUTRAL = theme.colors.text.secondary;

const layout: LayoutResult = {
  cells: [],
  labels: [],
  borders: [],
  cellSize: 20,
  contentWidth: 1000,
  contentHeight: 600,
  scrollable: false,
};

// Four nodes spread over the canvas, far enough apart that no arc is flipped and no hop numbers collide.
const anchors = new Map<string, FlowRect>([
  ['a', { x: 100, y: 300, w: 20, h: 20 }],
  ['b', { x: 500, y: 300, w: 20, h: 20 }],
  ['c', { x: 800, y: 300, w: 20, h: 20 }],
  ['d', { x: 500, y: 500, w: 20, h: 20 }],
]);

const edge = (source: string, destination: string, value: number | null, hops: FlowEdge['hops'] = []): FlowEdge => ({
  source,
  destination,
  value,
  rowCount: 1,
  hops,
});

// Color by value band, as thresholds do.
const colorOf = (e: FlowEdge) => (e.value! >= 1 ? '#ff0000' : '#00ff00');

const context = (over: Partial<FlowRenderContext>): FlowRenderContext => ({
  layout,
  viewportH: 600,
  anchors,
  base: [],
  focus: null,
  colorOf,
  theme,
  ...over,
});

type CanvasEvent = { type: string; props: Record<string, unknown> };
const eventsOf = (canvas: HTMLCanvasElement): CanvasEvent[] =>
  (canvas.getContext('2d') as unknown as { __getEvents(): CanvasEvent[] }).__getEvents();

function draw(over: Partial<FlowRenderContext>): CanvasEvent[] {
  const canvas = document.createElement('canvas');
  renderFlowOverlay(canvas, context(over));
  return eventsOf(canvas);
}

const count = (events: CanvasEvent[], type: string) => events.filter((e) => e.type === type).length;
const values = (events: CanvasEvent[], type: string) => events.filter((e) => e.type === type).map((e) => e.props.value);
// The stroke colors in the order the strokes were painted.
function strokeColors(events: CanvasEvent[]): unknown[] {
  const colors: unknown[] = [];
  let current: unknown;
  for (const e of events) {
    if (e.type === 'strokeStyle') {
      current = e.props.value;
    } else if (e.type === 'stroke') {
      colors.push(current);
    }
  }
  return colors;
}

describe('flowLineWidth', () => {
  it('is thin on dense grids and capped on large cells', () => {
    expect(flowLineWidth(6)).toBe(1.25);
    expect(flowLineWidth(20)).toBeCloseTo(1.8);
    expect(flowLineWidth(40)).toBe(2.5);
    expect(flowArrowSize(1.25)).toBe(6);
    expect(flowArrowSize(4)).toBe(11);
  });
});

describe('renderFlowOverlay', () => {
  it('sizes its canvas exactly like the cell canvas, so both share one coordinate system', () => {
    const tall: LayoutResult = { ...layout, contentWidth: 333.5, contentHeight: 120.5 };
    const cells = document.createElement('canvas');
    const overlay = document.createElement('canvas');
    renderCanvas(cells, {
      layout: tall,
      metricInfos: [],
      selectedRefId: 'A',
      displayMode: 'single',
      showValues: false,
      missingColor: '#444',
      theme,
      scrollTop: 0,
      viewportH: 300,
      categoryStyle: 'strip',
    });
    renderFlowOverlay(overlay, context({ layout: tall, viewportH: 300 }));
    expect([overlay.width, overlay.height]).toEqual([cells.width, cells.height]);
    expect([overlay.style.width, overlay.style.height]).toEqual([cells.style.width, cells.style.height]);
  });

  it('clears instead of resizing when the size did not change', () => {
    const canvas = document.createElement('canvas');
    renderFlowOverlay(canvas, context({}));
    let resized = 0;
    let width = canvas.width;
    Object.defineProperty(canvas, 'width', {
      get: () => width,
      set: (value: number) => {
        width = value;
        resized++;
      },
    });
    renderFlowOverlay(canvas, context({ base: [edge('a', 'b', 1)] }));
    expect(resized).toBe(0);
    expect(count(eventsOf(canvas), 'clearRect')).toBe(2);
  });

  it('draws nothing while no edge is to be shown (hover mode at rest)', () => {
    const events = draw({});
    expect(count(events, 'stroke') + count(events, 'fill') + count(events, 'fillText')).toBe(0);
  });

  it('draws a halo under every arc, then the arcs best first so the worst end up on top', () => {
    // base is worst first, as the model provides it.
    const events = draw({ base: [edge('a', 'b', 2), edge('b', 'c', 0)] });
    expect(strokeColors(events)).toEqual([BACKGROUND, BACKGROUND, '#00ff00', '#ff0000']);
    // Two halo strokes (arcs, arrowheads) are wider than the arcs they sit under.
    const lineWidth = flowLineWidth(layout.cellSize);
    expect(values(events, 'lineWidth').slice(0, 3)).toEqual([lineWidth + 2, 2, lineWidth]);
    // Each arc is traced twice (halo and color); each arrowhead is traced twice and filled in its color.
    expect(count(events, 'quadraticCurveTo')).toBe(4);
    expect(count(events, 'closePath')).toBe(4);
    expect(values(events, 'fillStyle')).toEqual(['#00ff00', '#ff0000']);
  });

  it('paints consecutive arcs of one color as a single stroke', () => {
    const events = draw({ base: [edge('a', 'b', 3), edge('b', 'c', 2), edge('c', 'd', 1), edge('d', 'a', 0)] });
    expect(strokeColors(events)).toEqual([BACKGROUND, BACKGROUND, '#00ff00', '#ff0000']);
    expect(count(events, 'fill')).toBe(2);
  });

  it('draws an edge without a value dashed in a neutral color, not on the color scale', () => {
    const neverCalled = jest.fn(() => '#123456');
    const events = draw({ base: [edge('a', 'b', null)], colorOf: neverCalled });
    expect(neverCalled).not.toHaveBeenCalled();
    expect(strokeColors(events)).toEqual([BACKGROUND, BACKGROUND, NEUTRAL]);
    const lineWidth = flowLineWidth(layout.cellSize);
    expect(events.filter((e) => e.type === 'setLineDash').map((e) => e.props.segments)).toEqual([
      [lineWidth * 2.5, lineWidth * 2.5],
      [],
    ]);
  });

  it('skips an edge whose endpoint has no place in the layout', () => {
    const events = draw({ base: [edge('a', 'missing', 1), edge('a', 'b', 1)] });
    expect(count(events, 'quadraticCurveTo')).toBe(2);
  });

  it('dims the other arcs and widens the focused ones', () => {
    const focused = edge('a', 'b', 0);
    const other = edge('b', 'c', 2);
    const events = draw({ base: [other, focused], focus: [focused] });
    const lineWidth = flowLineWidth(layout.cellSize);
    // First the dimmed context arc: its color only, no halo and no arrowhead.
    expect(values(events, 'globalAlpha').slice(0, 2)).toEqual([0.22, 1]);
    expect(strokeColors(events)).toEqual(['#ff0000', BACKGROUND, BACKGROUND, '#00ff00']);
    expect(values(events, 'lineWidth')).toEqual([lineWidth, lineWidth * 1.6 + 2, 2, lineWidth * 1.6]);
    expect(count(events, 'fill')).toBe(1);
  });

  it('draws focused edges that are not part of the resting set', () => {
    // Hover mode, or an edge the draw bound left out of the resting set.
    const events = draw({ base: [], focus: [edge('a', 'b', 2)] });
    expect(strokeColors(events)).toEqual([BACKGROUND, BACKGROUND, '#ff0000']);
  });

  it('writes the hop number beside the arrowhead', () => {
    const events = draw({
      base: [edge('a', 'b', 2, [{ path: 'ring-a', order: 1 }]), edge('b', 'c', 0, [{ path: 'ring-a', order: 2 }])],
    });
    const texts = events.filter((e) => e.type === 'fillText').map((e) => e.props.text);
    expect(texts).toEqual(['1', '2']);
    // Each number has a background-colored outline so it reads on any cell color.
    expect(count(events, 'strokeText')).toBe(2);
  });

  it('writes no number for an edge without a hop number', () => {
    const events = draw({ base: [edge('a', 'b', 2, [{ path: 'tree-a', order: null }]), edge('b', 'c', 1)] });
    expect(count(events, 'fillText')).toBe(0);
  });

  it('leaves out a hop number that would overlap one already written', () => {
    // Two edges between the same nodes in opposite directions and one more far away. The pair's
    // arrowheads are far apart, so use two nearly coincident sources to force an overlap instead.
    const near = new Map(anchors);
    near.set('a2', { x: 102, y: 300, w: 20, h: 20 });
    const events = draw({
      anchors: near,
      base: [
        edge('a', 'b', 2, [{ path: 'ring-a', order: 2 }]),
        edge('a2', 'b', 2, [{ path: 'ring-a', order: 1 }]),
        edge('c', 'd', 2, [{ path: 'ring-a', order: 3 }]),
      ],
    });
    // The lower hop number wins the contested spot.
    expect(events.filter((e) => e.type === 'fillText').map((e) => e.props.text)).toEqual(['1', '3']);
  });
});

describe('flowBadgeText', () => {
  it('shows the first hop number and marks an edge that carries more hops', () => {
    expect(flowBadgeText(edge('a', 'b', 1))).toBeNull();
    expect(flowBadgeText(edge('a', 'b', 1, [{ path: 'ring-a', order: 4 }]))).toBe('4');
    expect(
      flowBadgeText(
        edge('a', 'b', 1, [
          { path: 'ring-a', order: 4 },
          { path: 'ring-b', order: 9 },
        ])
      )
    ).toBe('4+');
    expect(flowBadgeText(edge('a', 'b', 1, [{ path: 'tree-a', order: null }]))).toBeNull();
  });
});
