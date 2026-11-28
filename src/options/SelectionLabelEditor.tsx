import React from 'react';
import { StandardEditorProps } from '@grafana/data';
import { InlineField, Input } from '@grafana/ui';
import { FleetGridOptions } from '../types';
import { selectionLabels } from '../selection/exportFormats';

/**
 * The label a cell selection is copied and synced by. Cells keep only the labels of the hierarchy
 * levels, so those are the choices. Without a label the copy buttons choose one when a selection
 * begins, and the variable sync writes nothing.
 */
export const SelectionLabelEditor: React.FC<StandardEditorProps<string, unknown, FleetGridOptions>> = ({
  value,
  onChange,
  context,
}) => {
  const labels = selectionLabels(context.options?.levels ?? []);
  const listId = `selection-labels-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const unknown = !!value && !labels.includes(value.trim());

  return (
    <div>
      <datalist id={listId}>
        {labels.map((label) => (
          <option value={label} key={label} />
        ))}
      </datalist>
      <InlineField label="Selection label" invalid={unknown} error="Not a hierarchy label: the copy buttons choose one, and nothing is synced">
        <Input
          aria-label="Selection label"
          list={listId}
          placeholder="Automatic"
          value={value ?? ''}
          onChange={(event) => onChange(event.currentTarget.value)}
          width={24}
        />
      </InlineField>
      <div style={{ marginTop: 8, opacity: 0.8 }}>Hierarchy labels: {labels.join(', ') || 'None'}</div>
    </div>
  );
};
