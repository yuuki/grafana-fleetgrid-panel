import fc from 'fast-check';
import {
  FLOW_APEX_MARGIN,
  FlowRect,
  MIN_FLOW_BULGE,
  flowAnchors,
  flowArc,
  flowArcPoint,
  flowArrowHead,
  flowBadgePoint,
} from './flowGeometry';
import { flowLayerSize } from './flowRenderer';
import { buildHierarchy } from '../data/hierarchy';
import { attachCells } from '../data/values';
import { computeLayout } from '../layout/layout';
import { propertyParams } from '../testing/property';
import { DEFAULT_LEVEL, LevelDef, NormalizedRow } from '../types';

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

const centre = (r: FlowRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
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
      fc.property(sized, ([width, height, a, b]) => {
        fc.pre(distinct(a, b));
        const arc = flowArc(a, b, width, height)!;
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

  it('starts every arc at the centre of its source and ends it at the centre of its destination, in real layouts', () => {
    // Grids as the layout code builds them, with host groups of any shape: one GPU, a square of GPUs, or
    // one long row of 16. An end of an arc is the centre of the node's rectangle, never a point that
    // depends on where the curve crosses a rectangle.
    const grid = fc.record({
      hosts: fc.integer({ min: 2, max: 40 }),
      gpus: fc.integer({ min: 1, max: 16 }),
      hostColumns: fc.integer({ min: 1, max: 10 }),
      gpuColumns: fc.integer({ min: 1, max: 16 }),
      hostLabels: fc.boolean(),
      width: fc.integer({ min: 200, max: 1600 }),
      height: fc.integer({ min: 120, max: 800 }),
    });
    fc.assert(
      fc.property(grid, fc.boolean(), (g, groups) => {
        const levels: LevelDef[] = [
          { ...DEFAULT_LEVEL, label: 'zone', layout: 'vertical', showBorder: true },
          { ...DEFAULT_LEVEL, label: 'host', layout: 'grid', gridColumns: g.hostColumns, showLabel: g.hostLabels },
          { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid', gridColumns: g.gpuColumns, showLabel: false },
        ];
        const rows: NormalizedRow[] = [];
        for (let host = 0; host < g.hosts; host++) {
          for (let gpu = 0; gpu < g.gpus; gpu++) {
            rows.push({ labels: { zone: 'zone-a', host: `node-a${host}`, gpu: `gpu${gpu}` }, value: 1, refId: 'A' });
          }
        }
        const { root } = buildHierarchy(rows, levels);
        attachCells(root, rows, levels, 'max');
        const layout = computeLayout(root, levels, g.width, g.height);
        // Edges between host groups, or between GPU cells.
        const anchors = [...flowAnchors(layout, groups ? 2 : 3).values()];
        const size = flowLayerSize({ layout, viewportW: g.width, viewportH: g.height });
        const step = Math.max(1, Math.floor(anchors.length / 12));
        for (let i = 0; i < anchors.length; i += step) {
          for (let j = 0; j < anchors.length; j += step) {
            const arc = flowArc(anchors[i], anchors[j], size.width, size.height);
            if (i === j) {
              expect(arc).toBeNull();
              continue;
            }
            expect([arc!.x0, arc!.y0]).toEqual([centre(anchors[i]).x, centre(anchors[i]).y]);
            expect([arc!.x1, arc!.y1]).toEqual([centre(anchors[j]).x, centre(anchors[j]).y]);
            // The centre of a node's rectangle is inside that rectangle: the arc touches its own two nodes.
            const apex = flowArcPoint(arc!, 0.5);
            expect(apex.x).toBeGreaterThanOrEqual(-1e-6);
            expect(apex.y).toBeGreaterThanOrEqual(-1e-6);
            expect(apex.x).toBeLessThanOrEqual(size.width + 1e-6);
            expect(apex.y).toBeLessThanOrEqual(size.height + 1e-6);
          }
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
