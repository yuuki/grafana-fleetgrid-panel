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
/** The bulge of the shortest arcs, in px: neighbouring cells still get a visible curve. */
export const MIN_FLOW_BULGE = 8;
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
  return Math.max(MIN_FLOW_BULGE, (BULGE_GAIN * length) / (1 + length / BULGE_SCALE));
}

/**
 * Distance that the apex of an arc keeps from the edge of the canvas, measured along the line through
 * the apex on which the arrowhead and the hop number sit, when the canvas has room for it. It is large
 * enough for the hop number, which is written beyond the arrowhead.
 */
export const FLOW_APEX_MARGIN = 24;

// The largest bulge towards one edge of the canvas. d0 and d1 are the distances of the arc's two ends
// from that edge and k (> 0) is the part of the unit normal that points at it.
// - The apex is at (d0 + d1) / 2 - k × bulge / 2 from the edge; it keeps `margin` along the normal.
// - The point of the arc at t is at (1 - t) d0 + t d1 - 2 t (1 - t) k × bulge from the edge. That is not
//   negative for any t exactly when bulge <= (√d0 + √d1)² / (2 k), so the whole arc is on the canvas,
//   not only its apex (an arc with one end at the edge leaves the canvas near that end first).
function edgeRoom(d0: number, d1: number, k: number, margin: number): number {
  const a = Math.max(0, d0);
  const b = Math.max(0, d1);
  const root = Math.sqrt(a) + Math.sqrt(b);
  return Math.min((a + b) / k - 2 * margin, (root * root) / (2 * k));
}

interface Chord {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// The largest bulge to the side of the unit normal (nx, ny) with which the whole arc stays on the canvas
// and its apex keeps `margin` from the edge. Only the edges that the normal points at limit it.
function sideRoom(c: Chord, nx: number, ny: number, width: number, height: number, margin: number): number {
  let room = Infinity;
  if (nx < 0) {
    room = Math.min(room, edgeRoom(c.x0, c.x1, -nx, margin));
  } else if (nx > 0) {
    room = Math.min(room, edgeRoom(width - c.x0, width - c.x1, nx, margin));
  }
  if (ny < 0) {
    room = Math.min(room, edgeRoom(c.y0, c.y1, -ny, margin));
  } else if (ny > 0) {
    room = Math.min(room, edgeRoom(height - c.y0, height - c.y1, ny, margin));
  }
  return Math.max(0, room);
}

/**
 * The arc from the centre of `from` to the centre of `to` on a canvas of width × height. It bulges to the
 * left of the direction of travel, so A→B and B→A are two separate curves. The whole arc stays on the
 * canvas, and its apex, where the arrowhead and the hop number are, keeps FLOW_APEX_MARGIN from the edge:
 * - when its own side has no room for the bulge and the other side has room for a bulge that is
 *   FLIP_GAIN larger, it bulges to that side instead, outside the arc of the opposite direction, which
 *   is already there;
 * - otherwise it stays on its own side and bulges only as far as fits there, down to a straight line;
 * - when that leaves both directions nearly straight (a canvas with no room on either side), each may
 *   bulge by MIN_FLOW_BULGE into the margin, as far as the canvas goes, so the two do not coincide.
 * The two ends are the two centres for cells and for groups alike: an end never depends on where the
 * curve crosses a rectangle. Returns null when the two centres coincide.
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
  const chord = { x0, y0, x1, y1 };
  // Left of the direction of travel in canvas coordinates (y grows downwards).
  let nx = dy / length;
  let ny = -dx / length;
  const wanted = flowBulge(length);
  const own = sideRoom(chord, nx, ny, width, height, FLOW_APEX_MARGIN);
  let bulge = wanted;
  if (own < wanted) {
    const other = sideRoom(chord, -nx, -ny, width, height, FLOW_APEX_MARGIN);
    if (other >= wanted * FLIP_GAIN) {
      nx = -nx;
      ny = -ny;
      bulge = wanted * FLIP_GAIN;
    } else if (own < MIN_FLOW_BULGE && other < MIN_FLOW_BULGE) {
      bulge = Math.max(own, Math.min(MIN_FLOW_BULGE, sideRoom(chord, nx, ny, width, height, 0)));
    } else {
      bulge = own;
    }
  }
  return { x0, y0, cx: (x0 + x1) / 2 + nx * bulge, cy: (y0 + y1) / 2 + ny * bulge, x1, y1, nx, ny };
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
