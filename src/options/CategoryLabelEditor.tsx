import React from 'react';
import { StandardEditorProps } from '@grafana/data';
import { InlineField, Input } from '@grafana/ui';
import { collectRangeOverrideSuggestions } from './suggestions';

export const CategoryLabelEditor: React.FC<StandardEditorProps<string>> = ({ value, onChange, context }) => {
  const suggestions = React.useMemo(() => collectRangeOverrideSuggestions(context.data ?? []), [context.data]);
  const labels = Object.keys(suggestions.valuesByLabel);
  const listId = `category-labels-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return (
    <div>
      <datalist id={listId}>
        {labels.map((label) => (
          <option value={label} key={label} />
        ))}
      </datalist>
      <InlineField label="Category label">
        <Input
          aria-label="Category label"
          list={listId}
          value={value ?? ''}
          onChange={(event) => onChange(event.currentTarget.value)}
          width={24}
        />
      </InlineField>
      <div style={{ marginTop: 8, opacity: 0.8 }}>Available labels: {labels.join(', ') || 'None'}</div>
    </div>
  );
};
