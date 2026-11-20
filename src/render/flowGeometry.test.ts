import { LayoutResult } from '../layout/layout';
import { pathKey } from '../data/hierarchy';
import { FlowRect, flowAnchors, flowArc, flowArcPoint, flowArrowHead, flowBadgePoint, flowBulge } from './flowGeometry';

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

  it('keeps the left side when neither side fits', () => {
    const arc = flowArc(rect(0, 0), rect(200, 0), 210, 10)!;
    expect(arc.ny).toBe(-1);
  });

  it('has no arc between two rectangles with the same centre', () => {
    expect(flowArc(rect(0, 0, 10, 10), rect(2, 2, 6, 6), BIG, BIG)).toBeNull();
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
