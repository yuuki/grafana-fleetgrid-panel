import { clampOverlay, placeOverlay } from './overlay';

describe('placeOverlay', () => {
  const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 300 };

  it('places to the lower-right when there is room', () => {
    expect(placeOverlay(10, 20, 100, 80, bounds)).toEqual({ left: 18, top: 28 });
  });

  it('flips to the left/top near the right/bottom edge and clamps within bounds', () => {
    // Near the bottom-right corner: flip to place at top-left, keeping it within min..max-size
    const p = placeOverlay(390, 290, 100, 80, bounds);
    expect(p.left).toBeGreaterThanOrEqual(bounds.minX);
    expect(p.top).toBeGreaterThanOrEqual(bounds.minY);
    expect(p.left + 100).toBeLessThanOrEqual(bounds.maxX);
    expect(p.top + 80).toBeLessThanOrEqual(bounds.maxY);
  });

  it('clamps to a scrolled (non-zero) visible range', () => {
    // The visible range shifts to [200,150]-[500,400] due to scrolling. Width 300 is exactly the same as the range width.
    const scrolled = { minX: 200, minY: 150, maxX: 500, maxY: 400 };
    const p = placeOverlay(480, 380, 300, 200, scrolled);
    expect(p.left).toBe(200); // A naive x-W-8=172 would fall below minX, so it's clamped to 200
    expect(p.top).toBeGreaterThanOrEqual(150);
    expect(p.top + 200).toBeLessThanOrEqual(400);
  });
});

describe('clampOverlay', () => {
  it('prefers lo when hi < lo (visible range narrower than size)', () => {
    expect(clampOverlay(50, 200, 100)).toBe(200);
  });
});
