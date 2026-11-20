import { pathKey } from '../data/hierarchy';
import { LayoutResult } from '../layout/layout';

// Geometry of the flow overlay: where an edge's two ends sit on the laid-out grid and the arc between
// them. Pure functions of the layout, so they are tested without a canvas.

export interface FlowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowPoint {
  x: number;
  y: number;
}

/** A quadratic Bézier from (x0, y0) to (x1, y1) with control point (cx, cy). */
export interface FlowArc {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  /** Unit normal that points to the side the arc bulges to. */
  nx: number;
  ny: number;
}

// How far the control point is from the chord: BULGE_GAIN × length for short chords, levelling off
// towards BULGE_GAIN × BULGE_SCALE for long ones. It grows strictly with the length, so arcs of
// different lengths over the same row of cells nest instead of covering each other.
const BULGE_GAIN = 0.35;
const BULGE_SCALE = 500;
const MIN_BULGE = 8;
// An arc that had to be flipped to the other side bulges more than the arc of the opposite direction,
// which already occupies that side, so the two do not coincide.
const FLIP_GAIN = 1.6;

/**
 * Rectangle of every hierarchy node at `depth` (path length): the cell itself at the leaf depth, otherwise
 * the bounding box of the group's cells. One pass over the laid-out cells.
 */
export function flowAnchors(layout: LayoutResult, depth: number): Map<string, FlowRect> {
  const anchors = new Map<string, FlowRect>();
  for (const c of layout.cells) {
    const key = pathKey(c.cell.path.slice(0, depth));
    const rect = anchors.get(key);
    if (!rect) {
      anchors.set(key, { x: c.x, y: c.y, w: c.w, h: c.h });
      continue;
    }
    const right = Math.max(rect.x + rect.w, c.x + c.w);
    const bottom = Math.max(rect.y + rect.h, c.y + c.h);
    rect.x = Math.min(rect.x, c.x);
    rect.y = Math.min(rect.y, c.y);
    rect.w = right - rect.x;
    rect.h = bottom - rect.y;
  }
  return anchors;
}

export function flowBulge(length: number): number {
  return Math.max(MIN_BULGE, (BULGE_GAIN * length) / (1 + length / BULGE_SCALE));
}

const inside = (x: number, y: number, width: number, height: number): boolean =>
  x >= 0 && y >= 0 && x <= width && y <= height;

/**
 * The arc from the centre of `from` to the centre of `to`. It bulges to the left of the direction of
 * travel, so A→B and B→A are two separate curves. When the arc's apex would leave the canvas (width ×
 * height) and the other side fits, it bulges to the right instead, by FLIP_GAIN more. Returns null when
 * the two centres coincide.
 */
export function flowArc(from: FlowRect, to: FlowRect, width: number, height: number): FlowArc | null {
  const x0 = from.x + from.w / 2;
  const y0 = from.y + from.h / 2;
  const x1 = to.x + to.w / 2;
  const y1 = to.y + to.h / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) {
    return null;
  }
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  // Left of the direction of travel in canvas coordinates (y grows downwards).
  let nx = dy / length;
  let ny = -dx / length;
  let bulge = flowBulge(length);
  // The apex of a quadratic Bézier is halfway between the chord's midpoint and the control point.
  const fitsLeft = inside(mx + (nx * bulge) / 2, my + (ny * bulge) / 2, width, height);
  const flipped = bulge * FLIP_GAIN;
  if (!fitsLeft && inside(mx - (nx * flipped) / 2, my - (ny * flipped) / 2, width, height)) {
    nx = -nx;
    ny = -ny;
    bulge = flipped;
  }
  return { x0, y0, cx: mx + nx * bulge, cy: my + ny * bulge, x1, y1, nx, ny };
}

/** The point of the arc at parameter t in [0, 1]. */
export function flowArcPoint(arc: FlowArc, t: number): FlowPoint {
  const u = 1 - t;
  return {
    x: u * u * arc.x0 + 2 * u * t * arc.cx + t * t * arc.x1,
    y: u * u * arc.y0 + 2 * u * t * arc.cy + t * t * arc.y1,
  };
}

/**
 * The arrowhead that marks the direction: a triangle centred on the arc's midpoint. At the midpoint a
 * quadratic Bézier runs parallel to its chord, so the triangle points from the source to the destination.
 * Returns [tip, base corner, base corner].
 */
export function flowArrowHead(arc: FlowArc, size: number): [FlowPoint, FlowPoint, FlowPoint] {
  const mid = flowArcPoint(arc, 0.5);
  const length = Math.hypot(arc.x1 - arc.x0, arc.y1 - arc.y0);
  const ux = (arc.x1 - arc.x0) / length;
  const uy = (arc.y1 - arc.y0) / length;
  const half = size / 2;
  const baseX = mid.x - ux * half;
  const baseY = mid.y - uy * half;
  return [
    { x: mid.x + ux * half, y: mid.y + uy * half },
    { x: baseX - uy * half, y: baseY + ux * half },
    { x: baseX + uy * half, y: baseY - ux * half },
  ];
}

/** Where an arc's hop number is written: beside the arrowhead, on the side the arc bulges to. */
export function flowBadgePoint(arc: FlowArc, distance: number): FlowPoint {
  const mid = flowArcPoint(arc, 0.5);
  return { x: mid.x + arc.nx * distance, y: mid.y + arc.ny * distance };
}
