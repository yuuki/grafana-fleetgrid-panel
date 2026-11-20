import { createTheme } from '@grafana/data';
import { FlowEdge } from '../data/edges';
import { LayoutResult } from '../layout/layout';
import { FlowRect } from './flowGeometry';
import { FlowRenderContext, flowArrowSize, flowBadgeText, flowLineWidth, renderFlowLayer } from './flowRenderer';
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
  edges: [],
  emphasised: false,
  retain: false,
  colorOf,
  theme,
  ...over,
});

type CanvasEvent = { type: string; props: Record<string, unknown> };
const eventsOf = (canvas: HTMLCanvasElement): CanvasEvent[] =>
  (canvas.getContext('2d') as unknown as { __getEvents(): CanvasEvent[] }).__getEvents();

function draw(over: Partial<FlowRenderContext>): CanvasEvent[] {
  const canvas = document.createElement('canvas');
  renderFlowLayer(canvas, context(over));
  return eventsOf(canvas);
}

const count = (events: CanvasEvent[], type: string) => events.filter((e) => e.type === type).length;
const values = (events: CanvasEvent[], type: string) => events.filter((e) => e.type === type).map((e) => e.props.value);
// The colors, widths and opacities of the strokes in the order they were painted.
function strokes(events: CanvasEvent[]): Array<{ color: unknown; width: unknown; alpha: unknown }> {
  const painted: Array<{ color: unknown; width: unknown; alpha: unknown }> = [];
  const state: { color: unknown; width: unknown; alpha: unknown } = { color: undefined, width: undefined, alpha: 1 };
  for (const e of events) {
    if (e.type === 'strokeStyle') {
      state.color = e.props.value;
    } else if (e.type === 'lineWidth') {
      state.width = e.props.value;
    } else if (e.type === 'globalAlpha') {
      state.alpha = e.props.value;
    } else if (e.type === 'stroke') {
      painted.push({ ...state });
    }
  }
  return painted;
}

const LINE = flowLineWidth(layout.cellSize);

describe('flowLineWidth', () => {
  it('is thin on dense grids and capped on large cells', () => {
    expect(flowLineWidth(6)).toBe(1.25);
    expect(flowLineWidth(20)).toBeCloseTo(1.8);
    expect(flowLineWidth(40)).toBe(2.5);
    expect(flowArrowSize(1.25)).toBe(6);
    expect(flowArrowSize(4)).toBe(11);
  });
});

describe('renderFlowLayer', () => {
  it('sizes its canvas exactly like the cell canvas, so both share one coordinate system', () => {
    const tall: LayoutResult = { ...layout, contentWidth: 333.5, contentHeight: 120.5 };
    const cells = document.createElement('canvas');
    const layer = document.createElement('canvas');
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
    renderFlowLayer(layer, context({ layout: tall, viewportH: 300, edges: [edge('a', 'b', 1)] }));
    expect([layer.width, layer.height]).toEqual([cells.width, cells.height]);
    expect([layer.style.width, layer.style.height]).toEqual([cells.style.width, cells.style.height]);
  });

  it('clears instead of resizing when the size did not change', () => {
    const canvas = document.createElement('canvas');
    renderFlowLayer(canvas, context({ edges: [edge('a', 'b', 1)] }));
    let resized = 0;
    let width = canvas.width;
    Object.defineProperty(canvas, 'width', {
      get: () => width,
      set: (value: number) => {
        width = value;
        resized++;
      },
    });
    renderFlowLayer(canvas, context({ edges: [edge('b', 'c', 1)] }));
    expect(resized).toBe(0);
    expect(count(eventsOf(canvas), 'clearRect')).toBe(2);
  });

  it('holds no backing store while it has no arcs, and keeps its place over the cells', () => {
    const canvas = document.createElement('canvas');
    renderFlowLayer(canvas, context({ edges: [edge('a', 'b', 1)] }));
    expect([canvas.width, canvas.height]).toEqual([1000, 600]);
    renderFlowLayer(canvas, context({}));
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect([canvas.style.width, canvas.style.height]).toEqual(['1000px', '600px']);
  });

  it('keeps and clears the store of a retaining layer, but does not allocate one just to stay empty', () => {
    const canvas = document.createElement('canvas');
    // Never painted: an empty retaining layer allocates nothing.
    renderFlowLayer(canvas, context({ retain: true }));
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    // Once it has arcs it keeps its store when they go away, and the old arcs are cleared.
    renderFlowLayer(canvas, context({ retain: true, edges: [edge('a', 'b', 1)] }));
    renderFlowLayer(canvas, context({ retain: true }));
    expect([canvas.width, canvas.height]).toEqual([1000, 600]);
    const events = eventsOf(canvas);
    expect(events[events.length - 1].type).toBe('clearRect');
    // A store of the wrong size is not worth keeping.
    renderFlowLayer(canvas, context({ retain: true, viewportH: 900 }));
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it('draws each arc over a halo, best first so the worst end up on top', () => {
    // edges are worst first, as the model provides them.
    const events = draw({ edges: [edge('a', 'b', 2), edge('b', 'c', 0)] });
    expect(strokes(events)).toEqual([
      // The better arc: halo, then color.
      { color: BACKGROUND, width: LINE + 2, alpha: 0.85 },
      { color: '#00ff00', width: LINE, alpha: 1 },
      // The worse arc, over it.
      { color: BACKGROUND, width: LINE + 2, alpha: 0.85 },
      { color: '#ff0000', width: LINE, alpha: 1 },
      // The outlines of the two arrowheads.
      { color: BACKGROUND, width: 2, alpha: 0.85 },
      { color: BACKGROUND, width: 2, alpha: 0.85 },
    ]);
    expect(count(events, 'quadraticCurveTo')).toBe(2);
    // One filled arrowhead per arc, in the arc's color, after all arcs.
    expect(values(events, 'fillStyle')).toEqual(['#00ff00', '#ff0000']);
    expect(count(events, 'fill')).toBe(2);
    const types = events.map((e) => e.type);
    expect(types.indexOf('fill')).toBeGreaterThan(types.lastIndexOf('quadraticCurveTo'));
  });

  it('draws an edge without a value dashed in a neutral color, not on the color scale', () => {
    const neverCalled = jest.fn(() => '#123456');
    const events = draw({ edges: [edge('a', 'b', null)], colorOf: neverCalled });
    expect(neverCalled).not.toHaveBeenCalled();
    expect(strokes(events)[1]).toEqual({ color: NEUTRAL, width: LINE, alpha: 1 });
    expect(events.filter((e) => e.type === 'setLineDash').map((e) => e.props.segments)).toEqual([
      [LINE * 2.5, LINE * 2.5],
      [],
    ]);
    // The dash is on while the arc is stroked in its color, not while its halo is.
    const types = events.map((e) => e.type);
    expect(types.indexOf('setLineDash')).toBeGreaterThan(types.indexOf('stroke'));
  });

  it('draws an edge with a value solid', () => {
    expect(count(draw({ edges: [edge('a', 'b', 0)] }), 'setLineDash')).toBe(0);
  });

  it('skips an edge whose endpoint has no place in the layout', () => {
    const events = draw({ edges: [edge('a', 'missing', 1), edge('a', 'b', 1)] });
    expect(count(events, 'quadraticCurveTo')).toBe(1);
  });

  it('draws the focus layer wider', () => {
    const events = draw({ edges: [edge('a', 'b', 2)], emphasised: true });
    expect(strokes(events).slice(0, 2)).toEqual([
      { color: BACKGROUND, width: LINE * 1.6 + 2, alpha: 0.85 },
      { color: '#ff0000', width: LINE * 1.6, alpha: 1 },
    ]);
  });

  it('outlines each cell or group the focused arcs connect, once, under the arcs', () => {
    const events = draw({ edges: [edge('a', 'b', 2), edge('b', 'c', 1), edge('c', 'a', 0)], emphasised: true });
    const rects = events.filter((e) => e.type === 'strokeRect').map((e) => e.props);
    // Three nodes, each outlined twice: a background-colored halo and the outline itself.
    expect(rects).toHaveLength(6);
    expect(rects.slice(3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 99, y: 299, width: 22, height: 22 }),
        expect.objectContaining({ x: 499, y: 299, width: 22, height: 22 }),
        expect.objectContaining({ x: 799, y: 299, width: 22, height: 22 }),
      ])
    );
    const types = events.map((e) => e.type);
    expect(types.lastIndexOf('strokeRect')).toBeLessThan(types.indexOf('quadraticCurveTo'));
    // The resting layer has no outlines.
    expect(count(draw({ edges: [edge('a', 'b', 2)] }), 'strokeRect')).toBe(0);
  });

  it('writes the hop number beside the arrowhead', () => {
    const events = draw({
      edges: [edge('a', 'b', 2, [{ path: 'ring-a', order: 1 }]), edge('b', 'c', 0, [{ path: 'ring-a', order: 2 }])],
    });
    const texts = events.filter((e) => e.type === 'fillText').map((e) => e.props.text);
    expect(texts).toEqual(['1', '2']);
    // Each number has a background-colored outline so it reads on any cell color.
    expect(count(events, 'strokeText')).toBe(2);
  });

  it('writes no number for an edge without a hop number', () => {
    const events = draw({ edges: [edge('a', 'b', 2, [{ path: 'tree-a', order: null }]), edge('b', 'c', 1)] });
    expect(count(events, 'fillText')).toBe(0);
  });

  it('leaves out a hop number that would overlap one already written', () => {
    // Two sources that nearly coincide give two arcs to b whose arrowheads sit on the same spot.
    const near = new Map(anchors);
    near.set('a2', { x: 102, y: 300, w: 20, h: 20 });
    const events = draw({
      anchors: near,
      edges: [
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
