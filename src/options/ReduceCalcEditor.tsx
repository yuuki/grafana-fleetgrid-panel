import React from 'react';
import { ReducerID, StandardEditorProps } from '@grafana/data';
import { Select } from '@grafana/ui';

// Only reducers that return a numeric scalar (array-type like allValues, boolean-type like allIsNull are excluded since they break the cell-value contract)
const NUMERIC_CALCS: ReducerID[] = [
  ReducerID.lastNotNull,
  ReducerID.last,
  ReducerID.mean,
  ReducerID.min,
  ReducerID.max,
  ReducerID.sum,
  ReducerID.count,
];

export const ReduceCalcEditor: React.FC<StandardEditorProps<string>> = ({ value, onChange }) => (
  <Select
    options={NUMERIC_CALCS.map((id) => ({ value: id as string, label: id as string }))}
    value={NUMERIC_CALCS.includes(value as ReducerID) ? value : ReducerID.lastNotNull}
    onChange={(v) => onChange(v.value ?? ReducerID.lastNotNull)}
  />
);
