import React, { useEffect, useMemo, useState } from 'react';
import { Button, useTheme2 } from '@grafana/ui';
import { CellModel } from '../types';
import { MetricInfo } from '../data/display';
import { copyText } from '../selection/clipboard';
import { compactHostlist, isHostlistName } from '../selection/hostlist';
import { toList, toRegex } from '../selection/exportFormats';
import { SyncStatus, syncMessage } from '../selection/variable';
import { ResolvedSelection } from '../selection/selection';
import { CohortDrawer } from './CohortDrawer';
import { SELECTION_BAR_H } from './useCellSelection';
import { SelectionExport } from './useSelectionExport';

export interface SelectionBarProps {
  /** The bar takes the keyboard focus after a pointer gesture. */
  barRef: React.Ref<HTMLDivElement>;
  /** Selected cells that are in the current data, and every other cell of it. */
  selected: CellModel[];
  rest: CellModel[];
  /** Selected cells that are not in the current data: they stay selected, but have no value and no labels now. */
  missingCount: number;
  /** The label the selection is exported by, and the distinct values the selected cells had for it. */
  label: string | undefined;
  values: string[];
  /** How many of the values come only from cells that are not in the current data. */
  valuesFromMissing: number;
  sync: SyncStatus;
  /** Every query of the panel and the display information of those that returned data, for the comparison. */
  refIds: string[];
  metricInfos: MetricInfo[];
  onClear: () => void;
}

type CopyFormat = 'regex' | 'list' | 'hostlist';

const FORMATS: Array<{ id: CopyFormat; name: string; describe: string }> = [
  { id: 'regex', name: 'Regex', describe: 'a regular expression' },
  { id: 'list', name: 'List', describe: 'a comma-separated list' },
  { id: 'hostlist', name: 'Hostlist', describe: 'a hostlist such as node-a[001-012]' },
];

function formatValues(format: CopyFormat, values: string[]): string | null {
  switch (format) {
    case 'regex':
      return toRegex(values);
    case 'list':
      return toList(values);
    case 'hostlist':
      return compactHostlist(values);
  }
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The controls of a cell selection, shown under the grid while cells are selected: the size of
 * the selection, the cohort comparison (which it opens in a drawer), one-click copy of the selected
 * label values in three formats, and Clear. Everything in it is a plain button, so it is the keyboard
 * side of the selection.
 */
export const SelectionBar: React.FC<SelectionBarProps> = ({
  barRef,
  selected,
  rest,
  missingCount,
  label,
  values,
  valuesFromMissing,
  sync,
  refIds,
  metricInfos,
  onClear,
}) => {
  const theme = useTheme2();
  const selectedCount = selected.length;
  const [comparing, setComparing] = useState(false);
  // Hostlist notation cannot express every value. The other formats can.
  const hostlistPossible = useMemo(() => values.every(isHostlistName), [values]);
  const [copied, setCopied] = useState<CopyFormat | undefined>(undefined);
  // The text of a copy that the browser refused, kept on screen so it can be copied by hand.
  const [failed, setFailed] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (copied === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (format: CopyFormat, text: string) => {
    copyText(text).then(
      () => {
        setFailed(undefined);
        setCopied(format);
      },
      () => {
        setCopied(undefined);
        setFailed(text);
      }
    );
  };
  const message = syncMessage(sync);

  return (
    <div
      ref={barRef}
      role="group"
      aria-label="Cell selection"
      data-testid="selection-bar"
      // Focusable by script only: the bar is not a tab stop, its buttons are.
      tabIndex={-1}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        minHeight: SELECTION_BAR_H,
        boxSizing: 'border-box',
        padding: '2px 0',
        borderTop: `1px solid ${theme.colors.border.weak}`,
        fontSize: 12,
        outline: 'none',
      }}
    >
      <span role="status" data-testid="selection-count">
        {`${plural(selectedCount, 'cell')} selected`}
        {missingCount > 0 && ` (+${missingCount} not in the current data)`}
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setComparing(true)}
        disabled={selectedCount === 0}
        data-testid="selection-compare"
      >
        Compare
      </Button>
      {label !== undefined && (
        <span style={{ color: theme.colors.text.secondary }} data-testid="selection-label">
          {plural(values.length, `${label} value`)}
          {valuesFromMissing > 0 && ` (${valuesFromMissing} from cells not in the current data)`}:
        </span>
      )}
      {FORMATS.map(({ id, name, describe }) => {
        const unavailable = values.length === 0 || (id === 'hostlist' && !hostlistPossible);
        return (
          <Button
            key={id}
            size="sm"
            variant={copied === id ? 'success' : 'secondary'}
            fill="outline"
            icon={copied === id ? 'check' : 'copy'}
            disabled={unavailable}
            data-testid={`selection-copy-${id}`}
            aria-label={`Copy the ${label ?? 'label'} values as ${describe}`}
            tooltip={
              id === 'hostlist' && !hostlistPossible
                ? 'Hostlist notation cannot express an empty value or one that contains , [ or ]'
                : `Copy the ${label ?? 'label'} values as ${describe}`
            }
            onClick={() => {
              // The text is built here, not while rendering: a selection can hold thousands of values.
              const text = unavailable ? null : formatValues(id, values);
              if (text !== null) {
                copy(id, text);
              }
            }}
          >
            {name}
          </Button>
        );
      })}
      <Button size="sm" variant="secondary" fill="text" onClick={onClear} data-testid="selection-clear">
        Clear
      </Button>
      {message && (
        <span
          data-testid="selection-sync"
          role={message.problem ? 'alert' : undefined}
          style={{ color: message.problem ? theme.colors.warning.text : theme.colors.text.secondary }}
        >
          {message.text}
        </span>
      )}
      {failed !== undefined && (
        <div role="alert" style={{ flexBasis: '100%', color: theme.colors.warning.text }}>
          <div>The browser did not allow copying. Select this text and copy it:</div>
          <textarea
            readOnly
            aria-label="Text that could not be copied"
            value={failed}
            rows={2}
            onFocus={(event) => event.currentTarget.select()}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              font: 'inherit',
              color: theme.colors.text.primary,
              background: theme.colors.background.secondary,
              border: `1px solid ${theme.colors.border.medium}`,
            }}
          />
        </div>
      )}
      {comparing && (
        <CohortDrawer
          selected={selected}
          rest={rest}
          missingCount={missingCount}
          refIds={refIds}
          metricInfos={metricInfos}
          onClose={() => setComparing(false)}
        />
      )}
    </div>
  );
};

export interface SelectionFooterProps {
  barRef: React.Ref<HTMLDivElement>;
  /** The selection, split into selected cells and the rest; undefined while nothing is selected. */
  selection: ResolvedSelection | undefined;
  exported: SelectionExport;
  refIds: string[];
  metricInfos: MetricInfo[];
  onClear: () => void;
}

/**
 * The selection bar while cells are selected, nothing otherwise. The panel renders on every pointer
 * move over the grid (the hover tooltip); these props keep their identity through that, so the bar is
 * skipped.
 */
export const SelectionFooter = React.memo(function SelectionFooter({
  barRef,
  selection,
  exported,
  refIds,
  metricInfos,
  onClear,
}: SelectionFooterProps) {
  if (!selection) {
    return null;
  }
  return (
    <SelectionBar
      barRef={barRef}
      selected={selection.selected}
      rest={selection.rest}
      missingCount={selection.missing}
      label={exported.label}
      values={exported.values}
      valuesFromMissing={exported.fromMissing}
      sync={exported.sync}
      refIds={refIds}
      metricInfos={metricInfos}
      onClear={onClear}
    />
  );
});
