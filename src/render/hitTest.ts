import { LayoutCell, LayoutResult } from '../layout/layout';

export function hitTest(layout: LayoutResult, x: number, y: number): LayoutCell | null {
  for (const c of layout.cells) {
    if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) {
      return c;
    }
  }
  return null;
}
