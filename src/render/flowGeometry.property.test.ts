import fc from 'fast-check';
import {
  FLOW_APEX_MARGIN,
  FlowAttach,
  FlowRect,
  MIN_FLOW_BULGE,
  flowArc,
  flowArcPoint,
  flowArrowHead,
  flowBadgePoint,
} from './flowGeometry';
import { propertyParams } from '../testing/property';

// Geometric invariants of an arc for any two rectangles on any canvas: it joins the two centres, its
// two directions never share a curve, every point of it is on the canvas, and its arrowhead points
// along the direction of travel.

const WIDTH = 1200;
const HEIGHT = 800;

const rect: fc.Arbitrary<FlowRect> = fc.record({
  x: fc.double({ min: 0, max: WIDTH - 40, noNaN: true }),
  y: fc.double({ min: 0, max: HEIGHT - 40, noNaN: true }),
  w: fc.double({ min: 6, max: 40, noNaN: true }),
  h: fc.double({ min: 6, max: 40, noNaN: true }),
});

const attach = fc.constantFrom<FlowAttach>('centre', 'frame');
const centre = (r: FlowRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
// The frames of two groups of one level do not overlap.
const apart = (a: FlowRect, b: FlowRect) =>
  a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
const distinct = (a: FlowRect, b: FlowRect) => Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y) > 1;

describe('flowArc (properties)', () => {
  it('joins the centres with finite coordinates and a unit normal', () => {
    fc.assert(
      fc.property(rect, rect, (a, b) => {
        fc.pre(distinct(a, b));
        const arc = flowArc(a, b, WIDTH, HEIGHT)!;
        expect(arc).not.toBeNull();
        expect([arc.x0, arc.y0]).toEqual([centre(a).x, centre(a).y]);
        expect([arc.x1, arc.y1]).toEqual([centre(b).x, centre(b).y]);
        expect(Number.isFinite(arc.cx) && Number.isFinite(arc.cy)).toBe(true);
        expect(Math.hypot(arc.nx, arc.ny)).toBeCloseTo(1);
      }),
      propertyParams()
    );
  });

  it('never draws the two directions of a pair on the same curve', () => {
    fc.assert(
      fc.property(rect, rect, (a, b) => {
        fc.pre(distinct(a, b));
        const forward = flowArc(a, b, WIDTH, HEIGHT)!;
        const backward = flowArc(b, a, WIDTH, HEIGHT)!;
        // Same end points, so the curves coincide exactly when the control points do.
        expect(Math.hypot(forward.cx - backward.cx, forward.cy - backward.cy)).toBeGreaterThan(4);
      }),
      propertyParams()
    );
  });

  // Any canvas, also one that is narrower or lower than the bulge the arc would like to have.
  const sized = fc
    .record({
      width: fc.double({ min: 46, max: 2 * WIDTH, noNaN: true }),
      height: fc.double({ min: 46, max: 2 * HEIGHT, noNaN: true }),
    })
    .chain(({ width, height }) => {
      const inCanvas = fc.record({
        x: fc.double({ min: 0, max: width - 40, noNaN: true }),
        y: fc.double({ min: 0, max: height - 40, noNaN: true }),
        w: fc.double({ min: 6, max: 40, noNaN: true }),
        h: fc.double({ min: 6, max: 40, noNaN: true }),
      });
      return fc.tuple(fc.constant(width), fc.constant(height), inCanvas, inCanvas);
    });

  it('keeps every point of the arc on the canvas, on any canvas', () => {
    fc.assert(
      fc.property(sized, attach, ([width, height, a, b], mode) => {
        fc.pre(distinct(a, b));
        const arc = flowArc(a, b, width, height, mode)!;
        for (let i = 0; i <= 64; i++) {
          const point = flowArcPoint(arc, i / 64);
          expect(point.x).toBeGreaterThanOrEqual(-1e-6);
          expect(point.y).toBeGreaterThanOrEqual(-1e-6);
          expect(point.x).toBeLessThanOrEqual(width + 1e-6);
          expect(point.y).toBeLessThanOrEqual(height + 1e-6);
        }
      }),
      propertyParams()
    );
  });

  it('keeps the two directions apart on any canvas, also one without room for the bulge', () => {
    fc.assert(
      fc.property(sized, ([width, height, a, b]) => {
        fc.pre(distinct(a, b));
        const forward = flowArc(a, b, width, height)!;
        const backward = flowArc(b, a, width, height)!;
        expect(Math.hypot(forward.cx - backward.cx, forward.cy - backward.cy)).toBeGreaterThan(4);
      }),
      propertyParams()
    );
  });

  it('keeps the two directions between two frames apart: they differ in an end or in the bulge', () => {
    fc.assert(
      fc.property(sized, ([width, height, a, b]) => {
        fc.pre(distinct(a, b) && apart(a, b));
        const forward = flowArc(a, b, width, height, 'frame')!;
        const backward = flowArc(b, a, width, height, 'frame')!;
        const far = Math.max(
          Math.hypot(forward.x0 - backward.x1, forward.y0 - backward.y1),
          Math.hypot(forward.x1 - backward.x0, forward.y1 - backward.y0),
          Math.hypot(forward.cx - backward.cx, forward.cy - backward.cy)
        );
        expect(far).toBeGreaterThan(2);
      }),
      propertyParams()
    );
  });

  it('never draws an arc between two frames across a cell of its own two groups', () => {
    const inside = (r: FlowRect, p: { x: number; y: number }) =>
      p.x > r.x + 1e-3 && p.x < r.x + r.w - 1e-3 && p.y > r.y + 1e-3 && p.y < r.y + r.h - 1e-3;
    fc.assert(
      fc.property(sized, ([width, height, a, b]) => {
        fc.pre(distinct(a, b) && apart(a, b));
        const arc = flowArc(a, b, width, height, 'frame')!;
        // An arc that would be too short between the frames is the arc between the centres.
        fc.pre(arc.x0 !== centre(a).x || arc.y0 !== centre(a).y);
        for (let i = 0; i <= 64; i++) {
          const point = flowArcPoint(arc, i / 64);
          expect(inside(a, point) || inside(b, point)).toBe(false);
        }
        expect(Math.hypot(arc.x1 - arc.x0, arc.y1 - arc.y0)).toBeGreaterThanOrEqual(12 - 1e-6);
        expect(Math.hypot(arc.nx, arc.ny)).toBeCloseTo(1);
      }),
      propertyParams()
    );
  });

  it('keeps the arrowhead and the hop number clear of the canvas edge whenever the arc is curved by choice', () => {
    // Only an arc of at most MIN_FLOW_BULGE can have been pushed into the margin (see flowArc).
    fc.assert(
      fc.property(sized, ([width, height, a, b]) => {
        fc.pre(distinct(a, b));
        const arc = flowArc(a, b, width, height)!;
        const bulge = Math.hypot(arc.cx - (arc.x0 + arc.x1) / 2, arc.cy - (arc.y0 + arc.y1) / 2);
        fc.pre(bulge > MIN_FLOW_BULGE + 1e-6);
        // The hop number is written up to FLOW_APEX_MARGIN beyond the apex, on the side of the bulge.
        const beyond = flowBadgePoint(arc, FLOW_APEX_MARGIN);
        expect(beyond.x).toBeGreaterThanOrEqual(-1e-6);
        expect(beyond.y).toBeGreaterThanOrEqual(-1e-6);
        expect(beyond.x).toBeLessThanOrEqual(width + 1e-6);
        expect(beyond.y).toBeLessThanOrEqual(height + 1e-6);
      }),
      propertyParams()
    );
  });

  it('points the arrowhead along the direction of travel, centred on the arc', () => {
    fc.assert(
      fc.property(rect, rect, fc.double({ min: 4, max: 12, noNaN: true }), (a, b, size) => {
        fc.pre(distinct(a, b));
        const arc = flowArc(a, b, WIDTH, HEIGHT)!;
        const [tip, left, right] = flowArrowHead(arc, size);
        const baseX = (left.x + right.x) / 2;
        const baseY = (left.y + right.y) / 2;
        const along = (tip.x - baseX) * (arc.x1 - arc.x0) + (tip.y - baseY) * (arc.y1 - arc.y0);
        expect(along).toBeGreaterThan(0);
        expect(Math.hypot(tip.x - baseX, tip.y - baseY)).toBeCloseTo(size);
        const mid = flowArcPoint(arc, 0.5);
        expect((tip.x + baseX) / 2).toBeCloseTo(mid.x);
        expect((tip.y + baseY) / 2).toBeCloseTo(mid.y);
      }),
      propertyParams()
    );
  });
});
