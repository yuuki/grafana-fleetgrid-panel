import { useMemo } from 'react';
import { LevelDef } from '../types';
import { configuredSelectionLabel } from '../selection/exportFormats';
import { compareNatural } from '../selection/hostlist';
import { ResolvedSelection, SelectionState, selectionValues } from '../selection/selection';
import { SyncStatus } from '../selection/variable';
import { useVariableSync } from './useVariableSync';

// One array for "no selected values", so the variable sync sees the same input until cells are selected.
const NO_VALUES: string[] = [];

export interface SelectionExport {
  /** The label the selection is copied by; undefined while nothing is selected or no level has a label. */
  label: string | undefined;
  /** The distinct values the selected cells had for that label when they were selected, in natural order. */
  values: string[];
  /** How many of the values come only from cells that are not in the current data. */
  fromMissing: number;
  sync: SyncStatus;
}

/**
 * What a selection is exported as: the label, its values, and the state of the sync of those values
 * to the dashboard variable named by `variableOption`.
 *
 * Neither the label nor the values follow the data. The label is the configured one, or else the one
 * chosen when the selection began. The values are those the cells had when they were selected. A data
 * update, including one that the panel's own write to the variable causes, therefore changes nothing
 * here, and so writes nothing.
 *
 * The variable is written only when the label is configured: what other panels are filtered by must
 * not depend on what was on screen when the selection began.
 */
export function useSelectionExport(
  selection: SelectionState,
  resolved: ResolvedSelection | undefined,
  labelOption: string | undefined,
  variableOption: string | undefined,
  levels: LevelDef[]
): SelectionExport {
  const configured = useMemo(() => configuredSelectionLabel(labelOption, levels), [labelOption, levels]);
  const label = configured ?? selection.autoLabel;
  const cells = selection.cells;
  // Which selected cells are in the current data changes with the data, the values do not: keep the
  // array of values while its content is the same, so that nothing downstream runs again.
  const exported = useMemo(() => {
    if (label === undefined || cells.size === 0) {
      return { values: NO_VALUES, fromMissing: 0 };
    }
    return selectionValues(cells, label, (key) => resolved?.selectedKeys.has(key) ?? false, compareNatural);
  }, [cells, label, resolved]);
  const valuesKey = JSON.stringify(exported.values);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const values = useMemo(() => (exported.values.length === 0 ? NO_VALUES : exported.values), [valuesKey]);
  const sync = useVariableSync(variableOption, configured, values);
  const fromMissing = exported.fromMissing;
  return useMemo(() => ({ label, values, fromMissing, sync }), [label, values, fromMissing, sync]);
}
