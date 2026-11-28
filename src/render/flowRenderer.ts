import { GrafanaTheme2 } from '@grafana/data';
import { FlowEdge } from '../data/edges';
import { LayoutResult } from '../layout/layout';
import { FlowArc, FlowPoint, FlowRect, flowArc, flowArrowHead, flowBadgePoint } from './flowGeometry';

// The flow overlay's draw pass. Arcs are painted on canvases of their own, stacked on the cell canvas:
// one layer for the arcs at rest and one for the arcs in focus. A change of focus (hover) paints the
// focus layer only; the resting layer is dimmed with CSS, and the cells are never painted again.

export interface FlowRenderContext {
  layout: LayoutResult;
  /** Width and height of the box that shows the grid: the panel body without the selection bar. */
  viewportW: number;
  viewportH: number;
  /** Rectangle of each hierarchy node that can be an endpoint (see flowAnchors). */
  anchors: Map<string, FlowRect>;
  /** The arcs of this layer, worst first. At most MAX_FLOW_ARCS. */
  edges: FlowEdge[];
  /** The focus layer draws its arcs wider and outlines the cells or groups they connect. */
  emphasised: boolean;
  /**
   * Whether the arcs run between groups of cells instead of between cells. An arc ends at the centre of
   * its group, where a cell happens to be. So every layer outlines the groups its arcs connect and
   * closes each arc with a hub at the group's centre: a mark of the group, in the color of its outline.
   */
  groupLevel: boolean;
  /**
   * Keep an allocated backing store while the layer has no arcs. The focus layer is emptied and filled
   * on every change of hover, and allocating a canvas each time costs more than clearing it. A layer
   * that does not retain its store (the resting layer, empty in hover mode) holds none while it is empty.
   */
  retain: boolean;
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
/** CSS opacity of the resting layer while a focus is shown. */
export const FLOW_DIM_OPACITY = 0.22;
// Dash and gap of an edge without a value, in line widths.
const DASH = 2.5;
const EMPHASIS = 1.6;
const OUTLINE_WIDTH = 1.5; // px, around the nodes of the arcs in focus
const REST_OUTLINE_WIDTH = 1; // px, around the groups of the arcs at rest
const OUTLINE_GAP = 1; // px between a cell or group and its outline
const BADGE_FONT_PX = 10;
const BADGE_CELL = 14; // px; size of the squares used to keep hop numbers from overlapping

/** Arc width in px: thin on dense grids so the cells stay visible, wider on large cells. */
export function flowLineWidth(cellSize: number): number {
  return Math.min(2.5, Math.max(1.25, cellSize * 0.09));
}

export function flowArrowSize(lineWidth: number): number {
  return Math.min(11, Math.max(6, lineWidth * 3.2));
}

/**
 * The most that a layer extends beyond the grid in one direction, in CSS px. An arc's apex is at most
 * 140 px from its chord (half the largest flipped bulge), so more room than this is never used.
 */
export const FLOW_SIDE_ROOM = 160;
/**
 * The largest canvas that Chromium paints: beyond a side of 65,535 px or 268,435,456 px in all it paints
 * nothing and reports no error. Both in device px.
 */
export const MAX_CANVAS_SIDE = 65535;
export const MAX_CANVAS_AREA = 268435456;

const canvasFits = (width: number, height: number, dpr: number): boolean => {
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  return w <= MAX_CANVAS_SIDE && h <= MAX_CANVAS_SIDE && w * h <= MAX_CANVAS_AREA;
};

// The room a layer adds beside the grid: only where the panel shows more than the grid, never more than
// the grid's own width (so a layer is at most twice the cell canvas), and never more than an arc can use.
const sideRoom = (content: number, viewport: number): number =>
  Math.max(0, Math.min(viewport - content, content, FLOW_SIDE_ROOM));

export interface FlowLayerSize {
  /** CSS px. */
  width: number;
  height: number;
  /** Whether a canvas of this size can be painted at the device pixel ratio. */
  drawable: boolean;
}

/**
 * The size of a layer. A layer starts at the cell canvas's origin, so both share one coordinate system.
 * It is as high as the cell canvas (the grid, or the panel when the grid is shorter), and as wide as the
 * cell canvas plus a bounded margin where the panel is wider than the grid: a grid that is narrower
 * than its panel (one column of zones) leaves an arc no room to bulge inside the grid. The margin is
 * bounded because the height can be the whole scroll length of the grid: a layer as wide as the panel
 * over a grid of 68 × 28,066 px took 174 MB. So a layer is never more than twice the cell canvas.
 * When the browser cannot paint the layer with its margin, the layer has the cell canvas's size; when it
 * cannot paint that either, the layer is not drawable and the legend says so.
 */
export function flowLayerSize(
  rc: Pick<FlowRenderContext, 'layout' | 'viewportW' | 'viewportH'>,
  dpr = 1
): FlowLayerSize {
  const { contentWidth, contentHeight } = rc.layout;
  // The cell canvas's own size (see prepareCanvas in renderer.ts).
  const height = Math.max(contentHeight, rc.viewportH);
  const width = contentWidth + sideRoom(contentWidth, rc.viewportW);
  if (canvasFits(width, height, dpr)) {
    return { width, height, drawable: true };
  }
  return { width: contentWidth, height, drawable: canvasFits(contentWidth, height, dpr) };
}

// Sizes and clears a layer. Unlike the cell canvas it keeps its backing store while the size is
// unchanged. Returns null when there is nothing to paint on.
function prepareLayer(canvas: HTMLCanvasElement, rc: FlowRenderContext, dpr: number): CanvasRenderingContext2D | null {
  const { width: cssW, height: cssH, drawable } = flowLayerSize(rc, dpr);
  const fullWidth = Math.round(cssW * dpr);
  const fullHeight = Math.round(cssH * dpr);
  const allocated = canvas.width === fullWidth && canvas.height === fullHeight;
  // An empty layer is released, unless it retains a store that already has the right size. A layer
  // that the browser cannot paint holds no store either.
  const release = !drawable || (rc.edges.length === 0 && !(rc.retain && allocated));
  const width = release ? 0 : fullWidth;
  const height = release ? 0 : fullHeight;
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = release ? null : canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return ctx;
}

// Shapes in draw order: the input is worst first, and the worst arcs must end up on top.
function shapesOf(rc: FlowRenderContext, width: number, height: number): Shape[] {
  const shapes: Shape[] = [];
  for (let i = rc.edges.length - 1; i >= 0; i--) {
    const edge = rc.edges[i];
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
  ctx.beginPath();
  ctx.moveTo(arc.x0, arc.y0);
  ctx.quadraticCurveTo(arc.cx, arc.cy, arc.x1, arc.y1);
}

function traceArrow(ctx: CanvasRenderingContext2D, arc: FlowArc, size: number): void {
  const [tip, left, right] = flowArrowHead(arc, size);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
}

// Each arc is stroked twice: first wider in the panel's background color (the halo), then in its own
// color. The halo separates an arc from the cells it crosses, in light and dark themes alike, and from
// the arcs drawn before it. Every arc is its own path: one path with all arcs is slower to rasterize
// (measured in Chromium, see docs/design.md), because its strokes overlap each other everywhere.
function strokeArcs(ctx: CanvasRenderingContext2D, shapes: Shape[], lineWidth: number, background: string): void {
  const dash = [lineWidth * DASH, lineWidth * DASH];
  for (const shape of shapes) {
    traceArc(ctx, shape.arc);
    ctx.globalAlpha = HALO_ALPHA;
    ctx.strokeStyle = background;
    ctx.lineWidth = lineWidth + 2 * HALO;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = lineWidth;
    // An edge without a value is dashed, so "unknown" does not depend on color alone.
    if (shape.edge.value === null) {
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.stroke();
    }
  }
}

// The direction cue: a filled arrowhead on the middle of each arc, outlined in the background color.
// Arrowheads are drawn after all arcs so that no arc covers the direction of another.
function fillArrows(ctx: CanvasRenderingContext2D, shapes: Shape[], arrowSize: number, background: string): void {
  ctx.lineWidth = 2 * HALO;
  ctx.strokeStyle = background;
  for (const shape of shapes) {
    traceArrow(ctx, shape.arc, arrowSize);
    ctx.globalAlpha = HALO_ALPHA;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = shape.color;
    ctx.fill();
  }
}

// The nodes that the arcs of a layer connect, each once.
function endpointKeys(shapes: Shape[]): Set<string> {
  const keys = new Set<string>();
  for (const shape of shapes) {
    keys.add(shape.edge.source);
    keys.add(shape.edge.destination);
  }
  return keys;
}

// The color of the marks of a node: its outline and, for a group, its hub. The marks of the focus are in
// the primary text color, so that they stand out against those of the resting layer.
const nodeMarkColor = (rc: FlowRenderContext): string =>
  rc.emphasised ? rc.theme.colors.text.primary : rc.theme.colors.text.secondary;

// The focus layer outlines every cell or group its arcs connect: the hovered node and its peers. For
// edges between groups the outline says that an arc belongs to the whole group, which its end at the
// group's centre cannot say, so the resting layer outlines groups too, thinner.
function outlineEndpoints(ctx: CanvasRenderingContext2D, shapes: Shape[], rc: FlowRenderContext): void {
  const lineWidth = rc.emphasised ? OUTLINE_WIDTH : REST_OUTLINE_WIDTH;
  const color = nodeMarkColor(rc);
  const keys = endpointKeys(shapes);
  const outline = (width: number, color: string, alpha: number) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    for (const key of keys) {
      const rect = rc.anchors.get(key)!;
      ctx.strokeRect(rect.x - OUTLINE_GAP, rect.y - OUTLINE_GAP, rect.w + 2 * OUTLINE_GAP, rect.h + 2 * OUTLINE_GAP);
    }
  };
  outline(lineWidth + 2 * HALO, rc.theme.colors.background.primary, HALO_ALPHA);
  outline(lineWidth, color, 1);
}

/** Radius of the hub at the centre of a group, in px. */
export function flowHubRadius(lineWidth: number): number {
  return Math.max(3, lineWidth * 1.75);
}

// An arc between groups ends at the centre of its group, on whatever cell is there. A hub closes it: a
// dot in the color of the group's outline, drawn over the ends of the arcs. It is not a cell's mark (a
// cell has none), and all arcs of the group meet in it, so the arc reads as attached to the outlined
// group. The end of an arc never depends on where the curve crosses the group's frame.
function drawHubs(ctx: CanvasRenderingContext2D, shapes: Shape[], rc: FlowRenderContext, radius: number): void {
  const dot = (r: number, color: string, alpha: number) => {
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    for (const key of endpointKeys(shapes)) {
      const rect = rc.anchors.get(key)!;
      ctx.beginPath();
      ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, r, 0, 2 * Math.PI);
      ctx.fill();
    }
  };
  dot(radius + HALO, rc.theme.colors.background.primary, HALO_ALPHA);
  dot(radius, nodeMarkColor(rc), 1);
}

/** The hop number written on an arc: its first numbered hop, with a "+" when the edge carries more hops. */
export function flowBadgeText(edge: FlowEdge): string | null {
  const numbered = edge.hops.find((hop) => hop.order !== null);
  if (!numbered) {
    return null;
  }
  return `${numbered.order}${edge.hops.length > 1 ? '+' : ''}`;
}

interface Badge {
  shape: Shape;
  text: string;
  path: string;
  order: number;
}

function badgesOf(shapes: Shape[]): Badge[] {
  const badges: Badge[] = [];
  for (const shape of shapes) {
    const numbered = shape.edge.hops.find((hop) => hop.order !== null);
    const text = flowBadgeText(shape.edge);
    if (numbered && text !== null) {
      badges.push({ shape, text, path: numbered.path, order: numbered.order! });
    }
  }
  return badges.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.order - b.order);
}

// Half the width and half the height of a hop number, in px.
const badgeHalfW = (text: string): number => (text.length * BADGE_FONT_PX * 0.62) / 2 + 1;
const BADGE_HALF_H = BADGE_FONT_PX / 2 + 1;

// Where a hop number is written: beside the arrowhead, on the side the arc bulges to. An arc keeps room
// for it there (FLOW_APEX_MARGIN) unless the canvas has no room on either side of the arc; the number
// is then moved back onto the canvas.
function badgePoint(arc: FlowArc, distance: number, text: string, width: number, height: number): FlowPoint {
  const at = flowBadgePoint(arc, distance);
  const halfW = badgeHalfW(text);
  return {
    x: Math.max(halfW, Math.min(width - halfW, at.x)),
    y: Math.max(BADGE_HALF_H, Math.min(height - BADGE_HALF_H, at.y)),
  };
}

// The squares of a coarse grid that a hop number written at (x, y) covers.
function badgeSquares(x: number, y: number, text: string): string[] {
  const halfW = badgeHalfW(text);
  const halfH = BADGE_HALF_H;
  const squares: string[] = [];
  for (let gx = Math.floor((x - halfW) / BADGE_CELL); gx <= Math.floor((x + halfW) / BADGE_CELL); gx++) {
    for (let gy = Math.floor((y - halfH) / BADGE_CELL); gy <= Math.floor((y + halfH) / BADGE_CELL); gy++) {
      squares.push(`${gx},${gy}`);
    }
  }
  return squares;
}

// Hop numbers, lowest first, each claiming its squares; a number whose squares are taken is not
// written. That keeps the numbers legible where many short hops meet, in one pass.
function drawBadges(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  arrowSize: number,
  size: { width: number; height: number },
  theme: GrafanaTheme2
): void {
  const badges = badgesOf(shapes);
  if (badges.length === 0) {
    return;
  }
  ctx.font = `600 ${BADGE_FONT_PX}px ${theme.typography.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme.colors.background.primary;
  ctx.fillStyle = theme.colors.text.primary;
  const taken = new Set<string>();
  for (const { shape, text } of badges) {
    const at = badgePoint(shape.arc, arrowSize / 2 + BADGE_FONT_PX * 0.8, text, size.width, size.height);
    const squares = badgeSquares(at.x, at.y, text);
    if (squares.some((square) => taken.has(square))) {
      continue;
    }
    squares.forEach((square) => taken.add(square));
    // A background-colored outline keeps the number readable on any cell color.
    ctx.strokeText(text, at.x, at.y);
    ctx.fillText(text, at.x, at.y);
  }
}

/**
 * Paints one layer of the flow overlay: its arcs, their arrowheads and their hop numbers. The cost is
 * proportional to the number of arcs of the layer.
 */
export function renderFlowLayer(canvas: HTMLCanvasElement, rc: FlowRenderContext): void {
  const dpr = window.devicePixelRatio || 1;
  const ctx = prepareLayer(canvas, rc, dpr);
  if (!ctx || rc.edges.length === 0) {
    return;
  }
  const size = flowLayerSize(rc, dpr);
  const shapes = shapesOf(rc, size.width, size.height);
  const lineWidth = flowLineWidth(rc.layout.cellSize) * (rc.emphasised ? EMPHASIS : 1);
  const arrowSize = flowArrowSize(lineWidth);
  const background = rc.theme.colors.background.primary;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (rc.emphasised || rc.groupLevel) {
    outlineEndpoints(ctx, shapes, rc);
  }
  strokeArcs(ctx, shapes, lineWidth, background);
  if (rc.groupLevel) {
    drawHubs(ctx, shapes, rc, flowHubRadius(lineWidth));
  }
  fillArrows(ctx, shapes, arrowSize, background);
  drawBadges(ctx, shapes, arrowSize, size, rc.theme);
}
