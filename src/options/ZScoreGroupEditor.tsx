import React from 'react';
import { StandardEditorProps } from '@grafana/data';
import { Select } from '@grafana/ui';
import { FleetGridOptions } from '../types';

export const ZScoreGroupEditor: React.FC<StandardEditorProps<number, unknown, FleetGridOptions>> = ({
  value,
  onChange,
  context,
}) => {
  const levels = context.options?.levels ?? [];
  const options: Array<{ value: number; label: string }> = [
    { value: -1, label: 'Parent group (default)' },
    { value: -2, label: 'Entire fleet' },
  ];
  for (let i = 0; i < Math.max(0, levels.length - 1); i++) {
    const label = levels[i]?.label || `Level ${i + 1}`;
    options.push({ value: i, label: `Within "${label}" (level ${i + 1})` });
  }
  const current = value !== undefined && options.some((opt) => opt.value === value) ? value : -1;
  return (
    <Select
      options={options}
      value={current}
      onChange={(selected) => onChange(selected.value ?? -1)}
    />
  );
};
