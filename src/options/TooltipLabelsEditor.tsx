import React from 'react';
import { StandardEditorProps } from '@grafana/data';
import { Button, IconButton, InlineField, InlineFieldRow, Input } from '@grafana/ui';
import { collectRangeOverrideSuggestions } from './suggestions';

export const TooltipLabelsEditor: React.FC<StandardEditorProps<string[]>> = ({ value, onChange, context }) => {
  const labels = Array.isArray(value) ? value : [];
  const suggestions = React.useMemo(() => collectRangeOverrideSuggestions(context.data ?? []), [context.data]);
  const availableLabels = Object.keys(suggestions.valuesByLabel);
  const instanceId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '-');
  const listId = `tooltip-labels-${instanceId}`;

  const update = (index: number, label: string) => {
    onChange(labels.map((current, currentIndex) => (currentIndex === index ? label : current)));
  };

  return (
    <div>
      <datalist id={listId}>
        {availableLabels.map((label) => (
          <option value={label} key={label} />
        ))}
      </datalist>
      <div style={{ marginBottom: 12, opacity: 0.8 }}>Available labels: {availableLabels.join(', ') || 'None'}</div>
      {labels.map((label, index) => (
        <InlineFieldRow key={index} data-testid={`tooltip-label-${index}`}>
          <InlineField label={`Label ${index + 1}`}>
            <Input
              aria-label={`Label name ${index + 1}`}
              list={listId}
              value={label}
              onChange={(event) => update(index, event.currentTarget.value)}
              width={24}
            />
          </InlineField>
          <IconButton
            name="trash-alt"
            data-testid={`remove-tooltip-label-${index}`}
            aria-label={`Remove label ${index + 1}`}
            tooltip="Remove label"
            onClick={() => onChange(labels.filter((_, currentIndex) => currentIndex !== index))}
          />
        </InlineFieldRow>
      ))}
      <Button icon="plus" variant="secondary" onClick={() => onChange([...labels, ''])}>
        Add label
      </Button>
    </div>
  );
};
