import { CellModel, HierarchyNode } from '../types';
import { buildCategoryModel, CATEGORY_OVERFLOW_COLOR, CATEGORY_PALETTE, primaryCategoryValue } from './categories';

const makeCell = (values: string[]): CellModel => ({
  path: [],
  labels: {},
  labelValues: new Map([['partition', values]]),
  values: new Map(),
});

const makeRoot = (cells: CellModel[]): HierarchyNode => ({
  key: '',
  path: [],
  children: cells.map((cell, i) => ({ key: String(i), path: [String(i)], children: [], cell })),
});

describe('buildCategoryModel', () => {
  it('assigns the fixed cool palette to the sorted distinct values in order', () => {
    const root = makeRoot([makeCell(['gpu', 'batch']), makeCell(['batch', 'cpu'])]);

    const model = buildCategoryModel(root, 'partition')!;

    expect(model.values).toEqual(['batch', 'cpu', 'gpu']);
    expect(model.colorByValue).toEqual(
      new Map([
        ['batch', CATEGORY_PALETTE[0]],
        ['cpu', CATEGORY_PALETTE[1]],
        ['gpu', CATEGORY_PALETTE[2]],
      ])
    );
  });

  it('folds the fifth and later values into the shared overflow color', () => {
    const root = makeRoot([makeCell(['a', 'b', 'c', 'd', 'e', 'f'])]);

    const model = buildCategoryModel(root, 'partition')!;

    expect(model.values).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect([...model.colorByValue.values()]).toEqual([
      CATEGORY_PALETTE[0],
      CATEGORY_PALETTE[1],
      CATEGORY_PALETTE[2],
      CATEGORY_PALETTE[3],
      CATEGORY_OVERFLOW_COLOR,
      CATEGORY_OVERFLOW_COLOR,
    ]);
  });

  it('does not draw category colors from the theme heatmap palette', () => {
    // The fixed palette is cool (blue/purple/cyan/magenta) precisely so it never collides with the
    // warm green→yellow→orange→red heatmap fill.
    expect(CATEGORY_PALETTE).toEqual(['#5794F2', '#7E4FD6', '#1EA3B6', '#C2409E']);
    expect(CATEGORY_OVERFLOW_COLOR).toBe('#8E9AAF');
  });

  it('chooses the alphabetically first value as the primary of a multi-value cell', () => {
    const cell = makeCell(['gpu', 'batch']);
    expect(primaryCategoryValue(cell, 'partition')).toBe('gpu');
  });

  it('returns undefined when no cell has the requested label', () => {
    const root: HierarchyNode = {
      key: '',
      path: [],
      children: [{ key: 'a', path: ['a'], children: [], cell: { path: [], labels: {}, values: new Map() } }],
    };

    expect(buildCategoryModel(root, 'partition')).toBeUndefined();
    expect(primaryCategoryValue(root.children[0].cell!, 'partition')).toBeUndefined();
  });
});
