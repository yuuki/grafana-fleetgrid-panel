import { CellModel, HierarchyNode } from '../types';
import { pathKey } from '../data/hierarchy';

/**
 * What is remembered of a cell when it is selected: its label sets at that moment, that is its values
 * for every hierarchy label. The copy formats and the variable sync read these, not the current data,
 * so what a selection stands for does not change while the selection exists: a selected node that
 * stops reporting keeps its host name in the selection.
 */
export interface SelectedCell {
  labelSets: Array<Record<string, string>>;
}

/**
 * The selected cells by cell key. A key is the cell's hierarchy path, so a selection does not depend
 * on where a cell is drawn or on its position in the query result: it survives a data refresh, a new
 * layout and a panel resize. Selections are never changed in place.
 */
export type CellSelection = ReadonlyMap<string, SelectedCell>;

export const EMPTY_SELECTION: CellSelection = new Map<string, SelectedCell>();

export const cellKey = (cell: CellModel): string => pathKey(cell.path);

const remember = (cell: CellModel): SelectedCell => ({
  labelSets: (cell.labelSets ?? [cell.labels]).map((labels) => ({ ...labels })),
});

/** Adds the cell when it is not selected, removes it when it is. */
export function toggleCell(selection: CellSelection, cell: CellModel): CellSelection {
  const key = cellKey(cell);
  const next = new Map(selection);
  if (!next.delete(key)) {
    next.set(key, remember(cell));
  }
  return next;
}

/**
 * Adds every cell. Returns the same selection when none of them is new. A cell that is selected
 * already keeps what was remembered of it.
 */
export function addCells(selection: CellSelection, cells: Iterable<CellModel>): CellSelection {
  let next: Map<string, SelectedCell> | undefined;
  for (const cell of cells) {
    const key = cellKey(cell);
    if (!selection.has(key)) {
      next ??= new Map(selection);
      next.set(key, remember(cell));
    }
  }
  return next ?? selection;
}

/**
 * Toggles a group of cells as one unit, the way a "select all" checkbox works: a group that is
 * already selected completely is removed, any other group (none or only part selected) is added.
 */
export function toggleGroup(selection: CellSelection, cells: CellModel[]): CellSelection {
  if (cells.length === 0) {
    return selection;
  }
  const keys = cells.map(cellKey);
  if (!keys.every((key) => selection.has(key))) {
    return addCells(selection, cells);
  }
  const next = new Map(selection);
  keys.forEach((key) => next.delete(key));
  return next;
}

/**
 * A selection together with the label it is exported by when the panel names none. That label is
 * chosen once, from the grid as it is when the first cell is selected, and kept until the selection
 * is cleared: a later change of the data must not turn a selection of hosts into one of GPUs.
 */
export interface SelectionState {
  cells: CellSelection;
  autoLabel: string | undefined;
}

export const NO_SELECTION: SelectionState = { cells: EMPTY_SELECTION, autoLabel: undefined };

/** The state after the cells changed. `chooseLabel` is asked only when a selection begins. */
export function withCells(
  state: SelectionState,
  cells: CellSelection,
  chooseLabel: () => string | undefined
): SelectionState {
  if (cells === state.cells) {
    return state;
  }
  if (cells.size === 0) {
    return NO_SELECTION;
  }
  return { cells, autoLabel: state.cells.size === 0 ? chooseLabel() : state.autoLabel };
}

/** Every cell of the hierarchy by cell key, in display order. */
export function indexCells(root: HierarchyNode): Map<string, CellModel> {
  const cells = new Map<string, CellModel>();
  const visit = (node: HierarchyNode) => {
    if (node.cell) {
      cells.set(cellKey(node.cell), node.cell);
    }
    node.children.forEach(visit);
  };
  visit(root);
  return cells;
}

/** The cells under the group with this hierarchy path, in display order. Empty when there is no such group. */
export function groupCells(root: HierarchyNode, path: string[]): CellModel[] {
  let node: HierarchyNode | undefined = root;
  for (const key of path) {
    node = node.children.find((child) => child.key === key);
    if (!node) {
      return [];
    }
  }
  const cells: CellModel[] = [];
  const visit = (current: HierarchyNode) => {
    if (current.cell) {
      cells.push(current.cell);
    }
    current.children.forEach(visit);
  };
  visit(node);
  return cells;
}

export interface ResolvedSelection {
  /** Selected cells that exist in the current data, in display order. */
  selected: CellModel[];
  /** The same cells as a set, for the renderer. */
  selectedSet: ReadonlySet<CellModel>;
  /** The keys of those cells: the selected keys that are in the current data. */
  selectedKeys: ReadonlySet<string>;
  /** Every other cell of the current data, in display order. */
  rest: CellModel[];
  /** Selected keys with no cell in the current data. They stay selected and come back with their cell. */
  missing: number;
}

/** Splits the current cells into the selected cohort and the rest. */
export function resolveSelection(cells: ReadonlyMap<string, CellModel>, selection: CellSelection): ResolvedSelection {
  const selected: CellModel[] = [];
  const selectedKeys = new Set<string>();
  const rest: CellModel[] = [];
  for (const [key, cell] of cells) {
    if (selection.has(key)) {
      selected.push(cell);
      selectedKeys.add(key);
    } else {
      rest.push(cell);
    }
  }
  return {
    selected,
    selectedSet: new Set(selected),
    selectedKeys,
    rest,
    missing: selection.size - selected.length,
  };
}

/** The values a selection has for one label, as they were when each cell was selected. */
export interface SelectionValues {
  /** Distinct values over all selected cells, in the order of `compare`. */
  values: string[];
  /** How many of them come only from cells that are not in the current data. */
  fromMissing: number;
}

/**
 * The distinct values the selected cells had for a label when they were selected. A cell that merges
 * several series (`node-a017` and `node-b017` under the key `017`) contributes each of their values.
 * `present` says which cell keys are in the current data; it only feeds `fromMissing`.
 */
export function selectionValues(
  selection: CellSelection,
  label: string,
  present: (key: string) => boolean,
  compare: (a: string, b: string) => number
): SelectionValues {
  // value → whether a cell of the current data has it
  const seen = new Map<string, boolean>();
  for (const [key, cell] of selection) {
    const here = present(key);
    for (const labels of cell.labelSets) {
      const value = labels[label];
      if (value !== undefined) {
        seen.set(value, here || seen.get(value) === true);
      }
    }
  }
  let fromMissing = 0;
  for (const here of seen.values()) {
    fromMissing += here ? 0 : 1;
  }
  return { values: [...seen.keys()].sort(compare), fromMissing };
}
