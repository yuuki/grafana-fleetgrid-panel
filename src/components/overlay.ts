/** Shares the placement calculation for click-originated overlays (popover/link menu). */

export interface VisibleBounds {
  /** The top-left/bottom-right corners of the visible range (content coordinates) at click time */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Clamps to lo..hi. When degenerate with hi<lo, prefers lo (a safeguard for when the visible range is narrower than the size). */
export const clampOverlay = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Places an overlay of size (w,h) near (x,y). On the side where it doesn't fit within the
 * right/bottom edge, flips the placement and clamps to both ends of the visible range (min..max) to prevent overflow.
 */
export function placeOverlay(x: number, y: number, w: number, h: number, b: VisibleBounds): { left: number; top: number } {
  const left = x + w + 16 > b.maxX ? clampOverlay(x - w - 8, b.minX, b.maxX - w) : x + 8;
  const top = y + h + 16 > b.maxY ? clampOverlay(y - h - 8, b.minY, b.maxY - h) : y + 8;
  return { left, top };
}
