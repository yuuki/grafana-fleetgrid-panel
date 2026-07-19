export interface RelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_SPLIT = 9;

function gridFor(n: number): [number, number] {
  if (n <= 1) {
    return [1, 1];
  }
  if (n === 2) {
    return [2, 1];
  }
  if (n === 3) {
    return [3, 1];
  }
  if (n === 4) {
    return [2, 2];
  }
  if (n <= 6) {
    return [3, 2];
  }
  return [3, 3];
}

export function splitRects(n: number): RelRect[] {
  const m = Math.max(1, Math.min(n, MAX_SPLIT));
  const [cols, rows] = gridFor(m);
  return Array.from({ length: m }, (_, i) => ({
    x: (i % cols) / cols,
    y: Math.floor(i / cols) / rows,
    w: 1 / cols,
    h: 1 / rows,
  }));
}
