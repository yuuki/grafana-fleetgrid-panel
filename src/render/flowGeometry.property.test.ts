import fc from 'fast-check';
import { FlowRect, flowArc, flowArcPoint, flowArrowHead } from './flowGeometry';
import { propertyParams } from '../testing/property';

// Geometric invariants of an arc for any two rectangles on any canvas: it joins the two centres, its
// two directions never share a curve, it stays on the canvas whenever one side allows it, and its
// arrowhead points along the direction of travel.

const WIDTH = 1200;
const HEIGHT = 800;

const rect: fc.Arbitrary<FlowRect> = fc.record({
  x: fc.double({ min: 0, max: WIDTH - 40, noNaN: true }),
  y: fc.double({ min: 0, max: HEIGHT - 40, noNaN: true }),
  w: fc.double({ min: 6, max: 40, noNaN: true }),
  h: fc.double({ min: 6, max: 40, noNaN: true }),
});

const centre = (r: FlowRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const distinct = (a: FlowRect, b: FlowRect) => Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y) > 1;
const onCanvas = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x <= WIDTH && p.y <= HEIGHT;

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

  it('keeps the apex on the canvas whenever one of the two sides fits', () => {
    fc.assert(
      fc.property(rect, rect, (a, b) => {
        fc.pre(distinct(a, b));
        const arc = flowArc(a, b, WIDTH, HEIGHT)!;
        const unbounded = flowArc(a, b, Infinity, Infinity)!;
        const flipped = arc.nx !== unbounded.nx || arc.ny !== unbounded.ny;
        if (flipped || onCanvas(flowArcPoint(unbounded, 0.5))) {
          expect(onCanvas(flowArcPoint(arc, 0.5))).toBe(true);
        }
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
