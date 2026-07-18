import React from 'react';
import { ReducerID, StandardEditorProps } from '@grafana/data';
import { Select } from '@grafana/ui';

// 数値スカラーを返すreducerのみ(allValues等の配列系、allIsNull等のboolean系はセル値契約を破るため除外)
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
