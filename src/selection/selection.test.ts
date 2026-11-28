import { CellModel, HierarchyNode } from '../types';
import {
  addCells,
  cellKey,
  EMPTY_SELECTION,
  groupCells,
  indexCells,
  NO_SELECTION,
  resolveSelection,
  selectionValues,
  toggleCell,
  toggleGroup,
  withCells,
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
        group(['zone-a', 'node-a001'], [leaf('zone-a', 'node-a001', 'gpu0'), leaf('zone-a', 'node-a001', 'gpu1')]),
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
    expect([...one.keys()]).toEqual([cellKey(cell('zone-a', 'gpu0'))]);
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
    expect([...without.keys()]).toEqual([cellKey(cell('zone-b', 'node-b001', 'gpu0'))]);
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
    expect([...resolved.selectedKeys]).toEqual([
      cellKey(cell('zone-a', 'node-a001', 'gpu1')),
      cellKey(cell('zone-b', 'node-b001', 'gpu0')),
    ]);
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
          [group(['zone-a', 'node-a001'], [leaf('zone-a', 'node-a001', 'gpu1'), leaf('zone-a', 'node-a001', 'gpu0')])]
        ),
      ]
    );
    const resolved = resolveSelection(indexCells(refreshed), selection);
    expect(paths(resolved.selected)).toEqual(['zone-a/node-a001/gpu1', 'zone-a/node-a001/gpu0']);
    expect(resolved.missing).toBe(0);
    expect(paths(resolved.rest)).toEqual(['zone-b/node-b001/gpu0']);
  });

  it('remembers the labels a cell has when it is selected, and keeps them when it is selected again', () => {
    const labelled = (host: string): CellModel => ({
      path: ['zone-a', '017'],
      labels: { zone: 'zone-a', host },
      labelSets: [{ zone: 'zone-a', host }],
      values: new Map(),
    });
    const first = labelled('node-a017');
    const selection = toggleCell(EMPTY_SELECTION, first);
    expect(selection.get(cellKey(first))).toEqual({ labelSets: [{ zone: 'zone-a', host: 'node-a017' }] });
    // The remembered labels are a copy: a later change of the cell does not reach them.
    first.labelSets![0].host = 'renamed';
    expect(selection.get(cellKey(first))!.labelSets[0].host).toBe('node-a017');
    // The cell comes back from a refresh with other labels and is covered by a drag: nothing changes.
    expect(addCells(selection, [labelled('node-b017')])).toBe(selection);
  });

  it('falls back to the representative labels of a cell that has no label sets', () => {
    const selection = toggleCell(EMPTY_SELECTION, { path: ['x'], labels: { host: 'node-a001' }, values: new Map() });
    expect([...selection.values()]).toEqual([{ labelSets: [{ host: 'node-a001' }] }]);
  });
});

describe('selection state', () => {
  const a = cell('zone-a', 'gpu0');
  const b = cell('zone-a', 'gpu1');

  it('chooses the label when a selection begins and keeps it until the selection is cleared', () => {
    const choose = jest.fn(() => 'host');
    const begun = withCells(NO_SELECTION, toggleCell(EMPTY_SELECTION, a), choose);
    expect(begun.autoLabel).toBe('host');
    expect(choose).toHaveBeenCalledTimes(1);

    // The grid has changed and would now give another answer: it is not asked.
    const other = jest.fn(() => 'gpu');
    const grown = withCells(begun, toggleCell(begun.cells, b), other);
    expect(grown.autoLabel).toBe('host');
    expect(grown.cells.size).toBe(2);
    const shrunk = withCells(grown, toggleCell(grown.cells, a), other);
    expect(shrunk.autoLabel).toBe('host');
    expect(other).not.toHaveBeenCalled();

    // Cleared: the next selection asks again.
    const cleared = withCells(shrunk, toggleCell(shrunk.cells, b), other);
    expect(cleared).toBe(NO_SELECTION);
    expect(withCells(cleared, toggleCell(EMPTY_SELECTION, a), other).autoLabel).toBe('gpu');
  });

  it('keeps the same state when the cells did not change', () => {
    const begun = withCells(NO_SELECTION, toggleCell(EMPTY_SELECTION, a), () => 'host');
    expect(withCells(begun, addCells(begun.cells, [a]), () => 'gpu')).toBe(begun);
    expect(withCells(NO_SELECTION, EMPTY_SELECTION, () => 'gpu')).toBe(NO_SELECTION);
  });
});

describe('selectionValues', () => {
  const gpu = (host: string, name: string): CellModel => ({
    path: ['zone-a', host, name],
    labels: { zone: 'zone-a', host, gpu: name },
    labelSets: [{ zone: 'zone-a', host, gpu: name }],
    values: new Map(),
  });
  const byName = (x: string, y: string) => x.localeCompare(y, 'en', { numeric: true });
  const everywhere = () => true;

  it('lists the distinct values the selected cells had for a label, in the given order', () => {
    const selection = addCells(EMPTY_SELECTION, [
      gpu('node-a10', 'gpu0'),
      gpu('node-a2', 'gpu0'),
      gpu('node-a2', 'gpu1'),
    ]);
    expect(selectionValues(selection, 'host', everywhere, byName)).toEqual({
      values: ['node-a2', 'node-a10'],
      fromMissing: 0,
    });
    expect(selectionValues(selection, 'gpu', everywhere, byName).values).toEqual(['gpu0', 'gpu1']);
    expect(selectionValues(selection, 'partition', everywhere, byName)).toEqual({ values: [], fromMissing: 0 });
    expect(selectionValues(EMPTY_SELECTION, 'host', everywhere, byName)).toEqual({ values: [], fromMissing: 0 });
  });

  it('includes every source value of a cell that merges several series', () => {
    const merged: CellModel = {
      path: ['017'],
      labels: { host: 'node-a017' },
      labelSets: [{ host: 'node-a017' }, { host: 'node-b017' }],
      values: new Map(),
    };
    expect(selectionValues(toggleCell(EMPTY_SELECTION, merged), 'host', everywhere, byName).values).toEqual([
      'node-a017',
      'node-b017',
    ]);
  });

  it('keeps the values of cells that left the data, and counts the values that only they have', () => {
    const down = gpu('node-a002', 'gpu0');
    const up = gpu('node-a001', 'gpu0');
    const upToo = gpu('node-a001', 'gpu1');
    const selection = addCells(EMPTY_SELECTION, [down, up, upToo]);
    // node-a002 stopped reporting: its cell is gone, its host name is still what was selected.
    const present = (key: string) => key !== cellKey(down);
    expect(selectionValues(selection, 'host', present, byName)).toEqual({
      values: ['node-a001', 'node-a002'],
      fromMissing: 1,
    });
    // A value that a present cell has as well is not "from missing cells".
    const onlyOneGpuLeft = (key: string) => key === cellKey(upToo);
    expect(selectionValues(selection, 'host', onlyOneGpuLeft, byName)).toEqual({
      values: ['node-a001', 'node-a002'],
      fromMissing: 1,
    });
    // Nothing of the selection is in the data.
    expect(selectionValues(selection, 'host', () => false, byName).fromMissing).toBe(2);
  });
});
