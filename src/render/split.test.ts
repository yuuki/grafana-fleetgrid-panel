import { splitRects } from './split';

describe('splitRects', () => {
  it('single region for n<=1', () => {
    expect(splitRects(1)).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });
  it('two columns for n=2', () => {
    expect(splitRects(2)).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]);
  });
  it('2x2 for n=4', () => {
    const r = splitRects(4);
    expect(r).toHaveLength(4);
    expect(r[3]).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
  it('3x2 for n=5..6 and 3x3 for n=7..9', () => {
    expect(splitRects(6)).toHaveLength(6);
    expect(splitRects(6)[5]).toEqual({ x: 2 / 3, y: 0.5, w: 1 / 3, h: 0.5 });
    expect(splitRects(9)).toHaveLength(9);
  });
  it('caps at 9 regions', () => {
    expect(splitRects(12)).toHaveLength(9);
  });
});
