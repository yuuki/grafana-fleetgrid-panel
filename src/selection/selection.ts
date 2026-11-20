import { CellModel, HierarchyNode } from '../types';
import { pathKey } from '../data/hierarchy';

/**
 * The selected cells, as a set of cell keys. A key is the cell's hierarchy path, so a selection does
 * not depend on where a cell is drawn or on its position in the query result: it survives a data
 * refresh, a new layout and a panel resize. Selections are never changed in place.
 */
export type CellSelection = ReadonlySet<string>;

export const EMPTY_SELECTION: CellSelection = new Set<string>();

export const cellKey = (cell: CellModel): string => pathKey(cell.path);

/** Adds the cell when it is not selected, removes it when it is. */
export function toggleCell(selection: CellSelection, cell: CellModel): CellSelection {
  const key = cellKey(cell);
  const next = new Set(selection);
  if (!next.delete(key)) {
    next.add(key);
  }
  return next;
}

/** Adds every cell. Returns the same selection when none of them is new. */
export function addCells(selection: CellSelection, cells: Iterable<CellModel>): CellSelection {
  let next: Set<string> | undefined;
  for (const cell of cells) {
    const key = cellKey(cell);
    if (!selection.has(key)) {
      next ??= new Set(selection);
      next.add(key);
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
  const next = new Set(selection);
  keys.forEach((key) => next.delete(key));
  return next;
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
  /** Every other cell of the current data, in display order. */
  rest: CellModel[];
  /** Selected keys with no cell in the current data. They stay selected and come back with their cell. */
  missing: number;
}

/** Splits the current cells into the selected cohort and the rest. */
export function resolveSelection(cells: ReadonlyMap<string, CellModel>, selection: CellSelection): ResolvedSelection {
  const selected: CellModel[] = [];
  const rest: CellModel[] = [];
  for (const [key, cell] of cells) {
    (selection.has(key) ? selected : rest).push(cell);
  }
  return { selected, selectedSet: new Set(selected), rest, missing: selection.size - selected.length };
}
