import { CellModel, HierarchyNode } from '../types';
import {
  addCells,
  cellKey,
  EMPTY_SELECTION,
  groupCells,
  indexCells,
  resolveSelection,
  toggleCell,
  toggleGroup,
} from './selection';

const cell = (...path: string[]): CellModel => ({ path, labels: {}, values: new Map() });

// zone-a: node-a001 (gpu0, gpu1), node-a002 (gpu0); zone-b: node-b001 (gpu0)
const leaf = (...path: string[]): HierarchyNode => ({
  key: path[path.length - 1],
  path,
  children: [],
  cell: cell(...path),
});
const group = (path: string[], children: HierarchyNode[]): HierarchyNode => ({
  key: path[path.length - 1] ?? '',
  path,
  children,
});
const root = group(
  [],
  [
    group(
      ['zone-a'],
      [
        group(
          ['zone-a', 'node-a001'],
          [leaf('zone-a', 'node-a001', 'gpu0'), leaf('zone-a', 'node-a001', 'gpu1')]
        ),
        group(['zone-a', 'node-a002'], [leaf('zone-a', 'node-a002', 'gpu0')]),
      ]
    ),
    group(['zone-b'], [group(['zone-b', 'node-b001'], [leaf('zone-b', 'node-b001', 'gpu0')])]),
  ]
);

const paths = (cells: CellModel[]) => cells.map((c) => c.path.join('/'));

describe('cell selection', () => {
  it('keys a cell by its hierarchy path, so equal names under different parents stay apart', () => {
    expect(cellKey(cell('zone-a', 'node-a001', 'gpu0'))).not.toBe(cellKey(cell('zone-b', 'node-b001', 'gpu0')));
    // A separator inside a key cannot fake another path.
    expect(cellKey(cell('a/b', 'c'))).not.toBe(cellKey(cell('a', 'b/c')));
    expect(cellKey(cell('zone-a', 'gpu0'))).toBe(cellKey(cell('zone-a', 'gpu0')));
  });

  it('toggles one cell in and out without changing the previous selection', () => {
    const one = toggleCell(EMPTY_SELECTION, cell('zone-a', 'gpu0'));
    expect([...one]).toEqual([cellKey(cell('zone-a', 'gpu0'))]);
    const none = toggleCell(one, cell('zone-a', 'gpu0'));
    expect(none.size).toBe(0);
    expect(one.size).toBe(1);
    expect(EMPTY_SELECTION.size).toBe(0);
  });

  it('adds cells and keeps the same selection when nothing is new', () => {
    const a = cell('zone-a', 'gpu0');
    const b = cell('zone-a', 'gpu1');
    const both = addCells(EMPTY_SELECTION, [a, b, a]);
    expect(both.size).toBe(2);
    expect(addCells(both, [b])).toBe(both);
    expect(addCells(both, [])).toBe(both);
  });

  it('toggles a group as one unit: add unless every cell of it is selected', () => {
    const cells = groupCells(root, ['zone-a']);
    const part = toggleCell(EMPTY_SELECTION, cells[0]);
    // Partly selected: the rest is added.
    const all = toggleGroup(part, cells);
    expect(all.size).toBe(3);
    // Completely selected: all of it is removed, other cells stay.
    const withOther = addCells(all, groupCells(root, ['zone-b']));
    const without = toggleGroup(withOther, cells);
    expect([...without]).toEqual([cellKey(cell('zone-b', 'node-b001', 'gpu0'))]);
    // No cells: nothing changes.
    expect(toggleGroup(withOther, [])).toBe(withOther);
  });

  it('lists the cells under a group path in display order', () => {
    expect(paths(groupCells(root, ['zone-a']))).toEqual([
      'zone-a/node-a001/gpu0',
      'zone-a/node-a001/gpu1',
      'zone-a/node-a002/gpu0',
    ]);
    expect(paths(groupCells(root, ['zone-a', 'node-a002']))).toEqual(['zone-a/node-a002/gpu0']);
    expect(paths(groupCells(root, []))).toHaveLength(4);
    expect(groupCells(root, ['zone-c'])).toEqual([]);
    expect(groupCells(root, ['zone-a', 'node-b001'])).toEqual([]);
  });

  it('splits the current cells into selected and rest, and counts selected keys without a cell', () => {
    const cells = indexCells(root);
    expect([...cells.values()].map((c) => c.path.join('/'))).toEqual([
      'zone-a/node-a001/gpu0',
      'zone-a/node-a001/gpu1',
      'zone-a/node-a002/gpu0',
      'zone-b/node-b001/gpu0',
    ]);
    const selection = addCells(EMPTY_SELECTION, [
      cell('zone-b', 'node-b001', 'gpu0'),
      cell('zone-a', 'node-a001', 'gpu1'),
      cell('zone-a', 'node-a009', 'gpu0'), // not in the data
    ]);
    const resolved = resolveSelection(cells, selection);
    // Display order, not selection order.
    expect(paths(resolved.selected)).toEqual(['zone-a/node-a001/gpu1', 'zone-b/node-b001/gpu0']);
    expect(paths(resolved.rest)).toEqual(['zone-a/node-a001/gpu0', 'zone-a/node-a002/gpu0']);
    expect(resolved.missing).toBe(1);
    expect(resolved.selectedSet.has(cells.get(cellKey(cell('zone-b', 'node-b001', 'gpu0')))!)).toBe(true);
    expect(resolved.selectedSet.size).toBe(2);
  });

  it('finds the same cells again in rebuilt data: a selection holds keys, not cell objects', () => {
    const selection = addCells(EMPTY_SELECTION, groupCells(root, ['zone-a', 'node-a001']));
    // The same topology from a new query result, in another order and without node-a002.
    const refreshed = group(
      [],
      [
        group(['zone-b'], [group(['zone-b', 'node-b001'], [leaf('zone-b', 'node-b001', 'gpu0')])]),
        group(
          ['zone-a'],
          [
            group(
              ['zone-a', 'node-a001'],
              [leaf('zone-a', 'node-a001', 'gpu1'), leaf('zone-a', 'node-a001', 'gpu0')]
            ),
          ]
        ),
      ]
    );
    const resolved = resolveSelection(indexCells(refreshed), selection);
    expect(paths(resolved.selected)).toEqual(['zone-a/node-a001/gpu1', 'zone-a/node-a001/gpu0']);
    expect(resolved.missing).toBe(0);
    expect(paths(resolved.rest)).toEqual(['zone-b/node-b001/gpu0']);
  });
});
