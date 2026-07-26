import { createTheme } from '@grafana/data';
import { CellModel, HierarchyNode } from '../types';
import { buildCategoryModel, primaryCategoryValue } from './categories';

const makeCell = (values: string[]): CellModel => ({
  path: [],
  labels: {},
  labelValues: new Map([['partition', values]]),
  values: new Map(),
});

const theme = createTheme();

const categoryTheme = (palette: string[]) =>
  ({
    ...theme,
    visualization: {
      ...theme.visualization,
      palette,
      getColorByName: (name: string) => `color:${name}`,
    },
  }) as typeof theme;

describe('buildCategoryModel', () => {
  it('collects sorted distinct values and assigns deterministic palette colors', () => {
    const root: HierarchyNode = {
      key: '',
      path: [],
      children: [
        { key: 'a', path: ['a'], children: [], cell: makeCell(['gpu', 'batch']) },
        { key: 'b', path: ['b'], children: [], cell: makeCell(['batch', 'cpu']) },
      ],
    };

    const model = buildCategoryModel(root, 'partition', categoryTheme(['red', 'blue']))!;

    expect(model.values).toEqual(['batch', 'cpu', 'gpu']);
    expect(model.colorByValue).toEqual(
      new Map([
        ['batch', 'color:red'],
        ['cpu', 'color:blue'],
        ['gpu', 'color:red'],
      ])
    );
  });

  it('wraps the palette and chooses the alphabetically first primary value', () => {
    const cell = makeCell(['batch', 'gpu']);
    const root: HierarchyNode = { key: '', path: [], children: [{ key: 'a', path: ['a'], children: [], cell }] };

    expect(primaryCategoryValue(cell, 'partition')).toBe('batch');
    expect(buildCategoryModel(root, 'partition', categoryTheme(['red']))!.colorByValue).toEqual(
      new Map([
        ['batch', 'color:red'],
        ['gpu', 'color:red'],
      ])
    );
  });

  it('returns undefined when no cell has the requested label', () => {
    const root: HierarchyNode = {
      key: '',
      path: [],
      children: [{ key: 'a', path: ['a'], children: [], cell: { path: [], labels: {}, values: new Map() } }],
    };

    expect(buildCategoryModel(root, 'partition', theme)).toBeUndefined();
    expect(primaryCategoryValue(root.children[0].cell!, 'partition')).toBeUndefined();
  });
});
