import { GrafanaTheme2 } from '@grafana/data';
import { FlowEdge } from '../data/edges';
import { LayoutResult } from '../layout/layout';
import { FlowArc, FlowRect, flowArc, flowArrowHead, flowBadgePoint } from './flowGeometry';

// The flow overlay's draw pass. It paints arcs on its own canvas, stacked on the cell canvas, so a
// change of focus (hover) repaints at most MAX_FLOW_ARCS arcs and never the cells.

export interface FlowRenderContext {
  layout: LayoutResult;
  viewportH: number;
  /** Rectangle of each hierarchy node that can be an endpoint (see flowAnchors). */
  anchors: Map<string, FlowRect>;
  /** Arcs drawn while nothing is focused, worst first. */
  base: FlowEdge[];
  /** Arcs to emphasise, worst first; the other base arcs are dimmed. null when nothing is focused. */
  focus: FlowEdge[] | null;
  /** Color of an edge that has a value. An edge without one is drawn dashed in a neutral color. */
  colorOf: (edge: FlowEdge) => string;
  theme: GrafanaTheme2;
}

interface Shape {
  edge: FlowEdge;
  arc: FlowArc;
  color: string;
}

const HALO = 1; // px of background color on each side of an arc, so it reads on any cell color
const HALO_ALPHA = 0.85;
const DIM_ALPHA = 0.22;
// Dash and gap of an edge without a value, in line widths.
const DASH = 2.5;
const EMPHASIS = 1.6;
const BADGE_FONT_PX = 10;
const BADGE_CELL = 14; // px; size of the squares used to keep hop numbers from overlapping

/** Arc width in px: thin on dense grids so the cells stay visible, wider on large cells. */
export function flowLineWidth(cellSize: number): number {
  return Math.min(2.5, Math.max(1.25, cellSize * 0.09));
}

export function flowArrowSize(lineWidth: number): number {
  return Math.min(11, Math.max(6, lineWidth * 3.2));
}

// The overlay must have exactly the cell canvas's size (prepareCanvas in renderer.ts) so that both share
// one coordinate system. Unlike the cell canvas it keeps its backing store when the size is unchanged:
// a hover only clears it.
function prepareOverlay(
  canvas: HTMLCanvasElement,
  layout: LayoutResult,
  viewportH: number,
  dpr: number
): CanvasRenderingContext2D | null {
  const cssW = layout.contentWidth;
  const cssH = Math.max(layout.contentHeight, viewportH);
  const width = Math.round(cssW * dpr);
  const height = Math.round(cssH * dpr);
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return ctx;
}

// Shapes in draw order: the input is worst first, and the worst arcs must end up on top.
function shapesOf(edges: FlowEdge[], rc: FlowRenderContext, width: number, height: number): Shape[] {
  const shapes: Shape[] = [];
  for (let i = edges.length - 1; i >= 0; i--) {
    const edge = edges[i];
    const from = rc.anchors.get(edge.source);
    const to = rc.anchors.get(edge.destination);
    const arc = from && to ? flowArc(from, to, width, height) : null;
    if (arc) {
      // Unknown is not a point on the color scale: a neutral color that reads in light and dark themes.
      shapes.push({ edge, arc, color: edge.value === null ? rc.theme.colors.text.secondary : rc.colorOf(edge) });
    }
  }
  return shapes;
}

function traceArc(ctx: CanvasRenderingContext2D, arc: FlowArc): void {
  ctx.moveTo(arc.x0, arc.y0);
  ctx.quadraticCurveTo(arc.cx, arc.cy, arc.x1, arc.y1);
}

function traceArrow(ctx: CanvasRenderingContext2D, arc: FlowArc, size: number): void {
  const [tip, left, right] = flowArrowHead(arc, size);
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
}

// Paints consecutive shapes of one color as a single path. Edges are sorted by value, so with
// thresholds a whole band of arcs is one stroke.
function paintRuns(shapes: Shape[], trace: (shape: Shape) => void, begin: () => void, paint: (color: string) => void) {
  let i = 0;
  while (i < shapes.length) {
    const color = shapes[i].color;
    begin();
    for (; i < shapes.length && shapes[i].color === color; i++) {
      trace(shapes[i]);
    }
    paint(color);
  }
}

function strokeRuns(ctx: CanvasRenderingContext2D, shapes: Shape[]): void {
  paintRuns(
    shapes,
    (shape) => traceArc(ctx, shape.arc),
    () => ctx.beginPath(),
    (color) => {
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  );
}

// The colored strokes. An edge without a value is dashed, so "unknown" does not depend on color alone.
function strokeArcs(ctx: CanvasRenderingContext2D, shapes: Shape[], lineWidth: number): void {
  ctx.lineWidth = lineWidth;
  const unknown = shapes.filter((shape) => shape.edge.value === null);
  if (unknown.length > 0) {
    ctx.setLineDash([lineWidth * DASH, lineWidth * DASH]);
    strokeRuns(ctx, unknown);
    ctx.setLineDash([]);
  }
  strokeRuns(ctx, unknown.length > 0 ? shapes.filter((shape) => shape.edge.value !== null) : shapes);
}

// The halo: every arc and arrowhead once more, wider and in the panel's background color, under the
// colored strokes. It separates an arc from the cells it crosses in light and dark themes alike.
function strokeHalo(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  lineWidth: number,
  arrowSize: number,
  color: string
): void {
  ctx.globalAlpha = HALO_ALPHA;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth + 2 * HALO;
  ctx.beginPath();
  shapes.forEach((shape) => traceArc(ctx, shape.arc));
  ctx.stroke();
  ctx.lineWidth = 2 * HALO;
  ctx.beginPath();
  shapes.forEach((shape) => traceArrow(ctx, shape.arc, arrowSize));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function fillArrows(ctx: CanvasRenderingContext2D, shapes: Shape[], arrowSize: number): void {
  paintRuns(
    shapes,
    (shape) => traceArrow(ctx, shape.arc, arrowSize),
    () => ctx.beginPath(),
    (color) => {
      ctx.fillStyle = color;
      ctx.fill();
    }
  );
}

/** The hop number written on an arc: its first numbered hop, with a "+" when the edge carries more hops. */
export function flowBadgeText(edge: FlowEdge): string | null {
  const numbered = edge.hops.find((hop) => hop.order !== null);
  if (!numbered) {
    return null;
  }
  return `${numbered.order}${edge.hops.length > 1 ? '+' : ''}`;
}

// Hop numbers, lowest first, each claiming the squares of a coarse grid; a number whose squares are
// taken is not written. That keeps the numbers legible where many short hops meet, in one pass.
function drawBadges(ctx: CanvasRenderingContext2D, shapes: Shape[], arrowSize: number, theme: GrafanaTheme2): void {
  const badges = shapes
    .map((shape) => ({ shape, text: flowBadgeText(shape.edge) }))
    .filter((badge): badge is { shape: Shape; text: string } => badge.text !== null)
    .sort((a, b) => {
      const ha = a.shape.edge.hops.find((hop) => hop.order !== null)!;
      const hb = b.shape.edge.hops.find((hop) => hop.order !== null)!;
      return (ha.path < hb.path ? -1 : ha.path > hb.path ? 1 : 0) || ha.order! - hb.order!;
    });
  if (badges.length === 0) {
    return;
  }
  ctx.font = `600 ${BADGE_FONT_PX}px ${theme.typography.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.colors.background.primary;
  ctx.fillStyle = theme.colors.text.primary;
  const taken = new Set<string>();
  for (const { shape, text } of badges) {
    const at = flowBadgePoint(shape.arc, arrowSize / 2 + BADGE_FONT_PX * 0.8);
    const halfW = (text.length * BADGE_FONT_PX * 0.62) / 2 + 1;
    const halfH = BADGE_FONT_PX / 2 + 1;
    const squares: string[] = [];
    for (let gx = Math.floor((at.x - halfW) / BADGE_CELL); gx <= Math.floor((at.x + halfW) / BADGE_CELL); gx++) {
      for (let gy = Math.floor((at.y - halfH) / BADGE_CELL); gy <= Math.floor((at.y + halfH) / BADGE_CELL); gy++) {
        squares.push(`${gx},${gy}`);
      }
    }
    if (squares.some((square) => taken.has(square))) {
      continue;
    }
    squares.forEach((square) => taken.add(square));
    ctx.strokeText(text, at.x, at.y);
    ctx.fillText(text, at.x, at.y);
  }
}

function drawArcs(ctx: CanvasRenderingContext2D, shapes: Shape[], lineWidth: number, theme: GrafanaTheme2): void {
  if (shapes.length === 0) {
    return;
  }
  const arrowSize = flowArrowSize(lineWidth);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokeHalo(ctx, shapes, lineWidth, arrowSize, theme.colors.background.primary);
  strokeArcs(ctx, shapes, lineWidth);
  fillArrows(ctx, shapes, arrowSize);
  drawBadges(ctx, shapes, arrowSize, theme);
}

export function renderFlowOverlay(canvas: HTMLCanvasElement, rc: FlowRenderContext): void {
  const dpr = window.devicePixelRatio || 1;
  const ctx = prepareOverlay(canvas, rc.layout, rc.viewportH, dpr);
  if (!ctx) {
    return;
  }
  const width = rc.layout.contentWidth;
  const height = Math.max(rc.layout.contentHeight, rc.viewportH);
  const lineWidth = flowLineWidth(rc.layout.cellSize);
  if (!rc.focus) {
    drawArcs(ctx, shapesOf(rc.base, rc, width, height), lineWidth, rc.theme);
    return;
  }
  // Focus: the other arcs stay as faint context (color only), the focused ones are drawn wider on top.
  const focused = new Set(rc.focus);
  const rest = shapesOf(
    rc.base.filter((edge) => !focused.has(edge)),
    rc,
    width,
    height
  );
  ctx.lineCap = 'round';
  ctx.globalAlpha = DIM_ALPHA;
  strokeArcs(ctx, rest, lineWidth);
  ctx.globalAlpha = 1;
  drawArcs(ctx, shapesOf(rc.focus, rc, width, height), lineWidth * EMPHASIS, rc.theme);
}
