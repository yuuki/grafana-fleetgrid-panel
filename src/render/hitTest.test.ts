import { hitTest } from './hitTest';
import { LayoutResult } from '../layout/layout';

const layout: LayoutResult = {
  cells: [
    { x: 0, y: 0, w: 10, h: 10, cell: { path: ['a'], labels: {}, values: new Map() } },
    { x: 11, y: 0, w: 10, h: 10, cell: { path: ['b'], labels: {}, values: new Map() } },
  ],
  labels: [],
  borders: [],
  cellSize: 10,
  contentWidth: 21,
  contentHeight: 10,
  scrollable: false,
};

describe('hitTest', () => {
  it('returns the cell under the point', () => {
    expect(hitTest(layout, 5, 5)?.cell.path).toEqual(['a']);
    expect(hitTest(layout, 12, 3)?.cell.path).toEqual(['b']);
  });
  it('returns null on gaps and outside', () => {
    expect(hitTest(layout, 10.5, 5)).toBeNull();
    expect(hitTest(layout, 5, 50)).toBeNull();
  });
});
