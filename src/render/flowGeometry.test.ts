import { LayoutResult } from '../layout/layout';
import { pathKey } from '../data/hierarchy';
import {
  FLOW_APEX_MARGIN,
  FlowRect,
  flowAnchors,
  flowArc,
  flowArcPoint,
  flowArrowHead,
  flowBadgePoint,
  flowBulge,
} from './flowGeometry';

const cell = (x: number, y: number, path: string[]) => ({
  x,
  y,
  w: 10,
  h: 10,
  cell: { path, labels: {}, values: new Map() },
});

// Two hosts of two GPUs side by side, then a third host on the next row.
const layout: LayoutResult = {
  cells: [
    cell(0, 0, ['zone-a', '1', 'gpu0']),
    cell(11, 0, ['zone-a', '1', 'gpu1']),
    cell(30, 0, ['zone-a', '2', 'gpu0']),
    cell(41, 0, ['zone-a', '2', 'gpu1']),
    cell(0, 20, ['zone-b', '1', 'gpu0']),
  ],
  labels: [],
  borders: [],
  cellSize: 10,
  contentWidth: 51,
  contentHeight: 30,
  scrollable: false,
};

const rect = (x: number, y: number, w = 10, h = 10): FlowRect => ({ x, y, w, h });
const BIG = 10000; // a canvas large enough that no arc is flipped

describe('flowAnchors', () => {
  it('anchors a leaf node at its cell', () => {
    const anchors = flowAnchors(layout, 3);
    expect(anchors.size).toBe(5);
    expect(anchors.get(pathKey(['zone-a', '1', 'gpu1']))).toEqual(rect(11, 0));
  });

  it('anchors a group at the bounding box of its cells', () => {
    const anchors = flowAnchors(layout, 2);
    expect([...anchors.keys()]).toEqual([pathKey(['zone-a', '1']), pathKey(['zone-a', '2']), pathKey(['zone-b', '1'])]);
    expect(anchors.get(pathKey(['zone-a', '1']))).toEqual(rect(0, 0, 21, 10));
    expect(flowAnchors(layout, 1).get(pathKey(['zone-a']))).toEqual(rect(0, 0, 51, 10));
  });

  it('does not change the layout it reads', () => {
    const before = JSON.stringify(layout.cells.map(({ x, y, w, h }) => [x, y, w, h]));
    flowAnchors(layout, 1);
    expect(JSON.stringify(layout.cells.map(({ x, y, w, h }) => [x, y, w, h]))).toBe(before);
  });
});

describe('flowBulge', () => {
  it('grows strictly with the chord length, so arcs over one row nest', () => {
    let previous = flowBulge(40);
    for (let length = 60; length <= 4000; length += 20) {
      const bulge = flowBulge(length);
      expect(bulge).toBeGreaterThan(previous);
      previous = bulge;
    }
  });

  it('keeps a visible curve for neighbouring cells', () => {
    expect(flowBulge(7)).toBe(8);
  });
});

describe('flowArc', () => {
  it('runs between the centres of the two rectangles', () => {
    const arc = flowArc(rect(0, 100), rect(200, 100, 20, 20), BIG, BIG)!;
    expect([arc.x0, arc.y0, arc.x1, arc.y1]).toEqual([5, 105, 210, 110]);
    expect(flowArcPoint(arc, 0)).toEqual({ x: 5, y: 105 });
    expect(flowArcPoint(arc, 1)).toEqual({ x: 210, y: 110 });
  });

  it('bulges to the left of the direction of travel', () => {
    // Left to right: the left-hand side is up (smaller y on a canvas).
    const right = flowArc(rect(0, 100), rect(200, 100), BIG, BIG)!;
    expect(right.cy).toBeLessThan(105);
    expect([right.nx, right.ny]).toEqual([0, -1]);
    // Top to bottom: the left-hand side is to the right (larger x).
    const down = flowArc(rect(100, 0), rect(100, 200), BIG, BIG)!;
    expect(down.cx).toBeGreaterThan(105);
  });

  it('separates the two directions of a pair', () => {
    const a = rect(0, 100);
    const b = rect(200, 160);
    const forward = flowArc(a, b, BIG, BIG)!;
    const backward = flowArc(b, a, BIG, BIG)!;
    // The control points mirror each other across the shared chord.
    const midX = (forward.x0 + forward.x1) / 2;
    const midY = (forward.y0 + forward.y1) / 2;
    expect(forward.cx - midX).toBeCloseTo(-(backward.cx - midX));
    expect(forward.cy - midY).toBeCloseTo(-(backward.cy - midY));
    expect(Math.hypot(forward.cx - backward.cx, forward.cy - backward.cy)).toBeCloseTo(
      2 * flowBulge(Math.hypot(200, 60))
    );
  });

  it('gives arcs of different lengths from one cell along a row different heights', () => {
    const from = rect(0, 500);
    const apexes = [100, 200, 400, 800].map((x) => flowArcPoint(flowArc(from, rect(x, 500), BIG, BIG)!, 0.5).y);
    expect(apexes).toEqual([...apexes].sort((a, b) => b - a));
    expect(new Set(apexes).size).toBe(4);
  });

  it('flips an arc whose apex would leave the canvas, clear of the opposite direction', () => {
    // Along the top edge: the left-to-right arc cannot bulge upwards.
    const a = rect(0, 0);
    const b = rect(200, 0);
    const forward = flowArc(a, b, 400, 400)!;
    const backward = flowArc(b, a, 400, 400)!;
    expect(forward.ny).toBe(1);
    expect(flowArcPoint(forward, 0.5).y).toBeGreaterThan(5);
    // Both now bulge downwards; the flipped one bulges more, so they do not coincide.
    expect(backward.ny).toBe(1);
    expect(forward.cy).toBeGreaterThan(backward.cy + 10);
  });

  it('bulges only as far as fits when neither side has room, so its middle stays on the canvas', () => {
    // A canvas as high as the row has no room on either side. The two directions still do not share a
    // line: each bulges by the smallest bulge to its own side, and stays on the canvas.
    const flat = flowArc(rect(0, 0), rect(200, 0), 210, 10)!;
    expect(flowArcPoint(flat, 0.5)).toEqual({ x: 105, y: 1 });
    expect(flowArcPoint(flowArc(rect(200, 0), rect(0, 0), 210, 10)!, 0.5)).toEqual({ x: 105, y: 9 });
    // A long vertical edge in a canvas 68 px wide (zones stacked in one column): the full bulge would
    // put the middle of the arc, with the arrowhead and the hop number, outside the canvas.
    const from = { x: 2, y: 34, w: 13, h: 13 };
    const to = { x: 53, y: 2990, w: 13, h: 13 };
    const narrow = flowArc(from, to, 68, 3026)!;
    for (let i = 0; i <= 100; i++) {
      const point = flowArcPoint(narrow, i / 100);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(68);
    }
    const apex = flowArcPoint(narrow, 0.5);
    // The hop number is written beyond the apex, along the arc's normal: that far the canvas goes on.
    expect(flowBadgePoint(narrow, FLOW_APEX_MARGIN).x).toBeLessThanOrEqual(68 + 1e-9);
    expect(apex.x).toBeLessThan(68 - FLOW_APEX_MARGIN + 0.01);
    // It still bulges as far as the canvas allows, rather than not at all.
    expect(Math.abs(apex.x - (from.x + to.x + 13) / 2)).toBeGreaterThan(5);
  });

  it('uses the full bulge again when the canvas is as wide as the panel', () => {
    const from = { x: 2, y: 34, w: 13, h: 13 };
    const to = { x: 53, y: 2990, w: 13, h: 13 };
    const wide = flowArc(from, to, 1550, 3026)!;
    const length = Math.hypot(51, 2956);
    expect(Math.hypot(wide.cx - 34, wide.cy - 1518.5)).toBeCloseTo(flowBulge(length));
    expect(flowArcPoint(wide, 0.5).x).toBeGreaterThan(68);
  });

  it('has no arc between two rectangles with the same centre', () => {
    expect(flowArc(rect(0, 0, 10, 10), rect(2, 2, 6, 6), BIG, BIG)).toBeNull();
    expect(flowArc(rect(0, 0, 10, 10), rect(2, 2, 6, 6), BIG, BIG, 'frame')).toBeNull();
  });
});

describe('flowArc between the frames of two groups', () => {
  const onBorder = (r: FlowRect, x: number, y: number): boolean => {
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
    const withinX = x > r.x - 1e-3 && x < r.x + r.w + 1e-3;
    const withinY = y > r.y - 1e-3 && y < r.y + r.h + 1e-3;
    return (withinY && (near(x, r.x) || near(x, r.x + r.w))) || (withinX && (near(y, r.y) || near(y, r.y + r.h)));
  };
  const inside = (r: FlowRect, x: number, y: number): boolean =>
    x > r.x + 1e-3 && x < r.x + r.w - 1e-3 && y > r.y + 1e-3 && y < r.y + r.h - 1e-3;
  const samples = (arc: NonNullable<ReturnType<typeof flowArc>>) =>
    Array.from({ length: 65 }, (_, i) => flowArcPoint(arc, i / 64));

  it('runs from the border of one frame to the border of the other, along the arc between their centres', () => {
    // Two groups of 5 × 5 cells with another group between them.
    const a = rect(100, 300, 220, 220);
    const b = rect(548, 300, 220, 220);
    const whole = flowArc(a, b, BIG, BIG)!;
    const arc = flowArc(a, b, BIG, BIG, 'frame')!;
    expect(onBorder(a, arc.x0, arc.y0)).toBe(true);
    expect(onBorder(b, arc.x1, arc.y1)).toBe(true);
    // It ends on the sides that face each other, and no point of it is on a cell of either group.
    expect(arc.x0).toBeCloseTo(320, 3);
    expect(arc.x1).toBeCloseTo(548, 3);
    for (const p of samples(arc)) {
      expect(inside(a, p.x, p.y) || inside(b, p.x, p.y)).toBe(false);
    }
    // It is a part of the arc between the centres: same apex, same side.
    expect(flowArcPoint(arc, 0.5).y).toBeCloseTo(flowArcPoint(whole, 0.5).y, 3);
    expect(arc.nx * whole.nx + arc.ny * whole.ny).toBeCloseTo(1);
    // The other direction is the mirror image below the line between the centres.
    const back = flowArc(b, a, BIG, BIG, 'frame')!;
    expect(back.x0).toBeCloseTo(548, 3);
    expect(back.y0).toBeCloseTo(820 - arc.y1, 3);
  });

  it('arches over the gap between two neighbouring frames instead of hiding in it', () => {
    // Two host groups of 2 × 2 cells, 4 px apart.
    const a = rect(100, 300, 26, 26);
    const b = rect(130, 300, 26, 26);
    const over = flowArc(a, b, BIG, BIG, 'frame')!;
    // From the top of one frame to the top of the other, 6 px above them at its middle.
    expect(over.y0).toBeCloseTo(300, 3);
    expect(over.y1).toBeCloseTo(300, 3);
    expect(over.x0).toBeGreaterThan(113);
    expect(over.x1).toBeLessThan(143);
    expect(over.x1 - over.x0).toBeGreaterThan(12);
    expect(flowArcPoint(over, 0.5)).toEqual({ x: expect.closeTo(128, 3), y: expect.closeTo(294, 3) });
    const under = flowArc(b, a, BIG, BIG, 'frame')!;
    expect(under.y0).toBeCloseTo(326, 3);
    expect(flowArcPoint(under, 0.5).y).toBeCloseTo(332, 3);
    // The arrowhead still points from the source to the destination.
    expect(flowArrowHead(over, 8)[0].x).toBeGreaterThan(128);
    expect(flowArrowHead(under, 8)[0].x).toBeLessThan(128);
  });

  it('arches over two neighbouring frames of any size', () => {
    // Two zones of 5 × 5 cells side by side, and two stacked in one column.
    const row = flowArc(rect(0, 400, 220, 220), rect(224, 400, 220, 220), BIG, BIG, 'frame')!;
    expect([row.y0, row.y1]).toEqual([expect.closeTo(400, 3), expect.closeTo(400, 3)]);
    expect(flowArcPoint(row, 0.5).y).toBeCloseTo(394, 3);
    const column = flowArc(rect(400, 0, 220, 220), rect(400, 224, 220, 220), BIG, BIG, 'frame')!;
    // Top to bottom bulges to the right: from the right side of one to the right side of the other.
    expect([column.x0, column.x1]).toEqual([expect.closeTo(620, 3), expect.closeTo(620, 3)]);
    expect(flowArcPoint(column, 0.5).x).toBeCloseTo(626, 3);
  });

  it('keeps the arc between the centres when the part between the frames would be too short to see', () => {
    // Two neighbouring groups in a panel as high as they are: the arc cannot arch over them.
    const a = rect(0, 0, 26, 26);
    const b = rect(30, 0, 26, 26);
    const arc = flowArc(a, b, 300, 26, 'frame')!;
    expect([arc.x0, arc.y0, arc.x1, arc.y1]).toEqual([13, 13, 43, 13]);
    // Two frames that overlap have no part between them either.
    const overlapping = flowArc(rect(0, 100, 100, 100), rect(40, 140, 100, 100), BIG, BIG, 'frame')!;
    expect([overlapping.x0, overlapping.y0]).toEqual([50, 150]);
  });
});

describe('flowArrowHead', () => {
  it('sits on the middle of the arc and points from the source to the destination', () => {
    const arc = flowArc(rect(0, 100), rect(200, 100), BIG, BIG)!;
    const mid = flowArcPoint(arc, 0.5);
    const [tip, left, right] = flowArrowHead(arc, 8);
    expect(tip).toEqual({ x: mid.x + 4, y: mid.y });
    expect(left).toEqual({ x: mid.x - 4, y: mid.y + 4 });
    expect(right).toEqual({ x: mid.x - 4, y: mid.y - 4 });
    const [reverseTip] = flowArrowHead(flowArc(rect(200, 100), rect(0, 100), BIG, BIG)!, 8);
    expect(reverseTip.x).toBeLessThan(105);
  });

  it('puts the hop number outside the bulge', () => {
    const arc = flowArc(rect(0, 100), rect(200, 100), BIG, BIG)!;
    const mid = flowArcPoint(arc, 0.5);
    expect(flowBadgePoint(arc, 12)).toEqual({ x: mid.x, y: mid.y - 12 });
  });
});
