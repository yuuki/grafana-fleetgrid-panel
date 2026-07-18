import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos } from '../data/display';
import { SplitLegend } from './SplitLegend';

const theme = createTheme();
const frame = (refId: string, name: string) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1] },
      { name: 'Value', type: FieldType.number, values: [1], labels: {} },
    ],
  });

describe('SplitLegend', () => {
  it('lists region number and query name in order', () => {
    const infos = buildMetricInfos([frame('A', 'power'), frame('B', 'temp')], theme, 'browser');
    render(<SplitLegend metricInfos={infos} />);
    expect(screen.getByText('1: power')).toBeInTheDocument();
    expect(screen.getByText('2: temp')).toBeInTheDocument();
  });
  it('warns when more than 9 queries', () => {
    const infos = buildMetricInfos(
      Array.from({ length: 11 }, (_, i) => frame(String.fromCharCode(65 + i), `m${i}`)),
      theme,
      'browser'
    );
    render(<SplitLegend metricInfos={infos} />);
    expect(screen.getByText(/9クエリまで/)).toBeInTheDocument();
    expect(screen.getByText(/2件は非表示/)).toBeInTheDocument();
  });
});
