import { useMemo } from 'react';
import { HierarchyNode, LevelDef } from '../types';
import { labelValues, resolveSelectionLabel } from '../selection/exportFormats';
import { ResolvedSelection } from '../selection/selection';
import { SyncStatus } from '../selection/variable';
import { useVariableSync } from './useVariableSync';

// One array for "no selected values", so the variable sync sees the same input until cells are selected.
const NO_VALUES: string[] = [];

export interface SelectionExport {
  /** The label the selection is copied and synced by; undefined while nothing is selected. */
  label: string | undefined;
  /** The distinct values of that label over the selected cells, in natural order. */
  values: string[];
  sync: SyncStatus;
}

/**
 * What a selection is exported as: the label, its values over the selected cells, and the state of
 * the sync of those values to the dashboard variable named by `variableOption`.
 *
 * Choosing the label reads every cell, so it waits until cells are selected. It depends on the grid,
 * not on which cells are selected, so a change of the selection does not repeat it.
 */
export function useSelectionExport(
  resolved: ResolvedSelection | undefined,
  labelOption: string | undefined,
  variableOption: string | undefined,
  root: HierarchyNode,
  levels: LevelDef[]
): SelectionExport {
  const hasSelection = resolved !== undefined;
  const label = useMemo(
    () => (hasSelection ? resolveSelectionLabel(labelOption, root, levels) : undefined),
    [hasSelection, labelOption, root, levels]
  );
  const selected = resolved?.selected;
  const values = useMemo(
    () => (selected && label !== undefined ? labelValues(selected, label) : NO_VALUES),
    [selected, label]
  );
  const sync = useVariableSync(variableOption, values);
  return useMemo(() => ({ label, values, sync }), [label, values, sync]);
}
