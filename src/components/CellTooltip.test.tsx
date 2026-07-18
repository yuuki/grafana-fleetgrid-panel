import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos } from '../data/display';
import { CellTooltip } from './CellTooltip';

const theme = createTheme();
const frames = [
  toDataFrame({
    refId: 'A',
    name: 'power',
    fields: [
      { name: 'Time', type: FieldType.time, values: [1] },
      { name: 'Value', type: FieldType.number, values: [503], labels: { zone: 'zone-a' }, config: { unit: 'watt' } },
    ],
  }),
  toDataFrame({
    refId: 'B',
    name: 'temp',
    fields: [
      { name: 'Time', type: FieldType.time, values: [1] },
      { name: 'Value', type: FieldType.number, values: [61], labels: { zone: 'zone-a' } },
    ],
  }),
];

describe('CellTooltip', () => {
  it('shows path and all metric values including missing', () => {
    const infos = buildMetricInfos(frames, theme, 'browser');
    const cell = {
      path: ['zone-a', '0'],
      labels: { zone: 'zone-a' },
      values: new Map<string, number | null>([
        ['A', 503],
        ['B', null],
      ]),
    };
    render(<CellTooltip cell={cell} metricInfos={infos} missingColor="#444" x={0} y={0} />);
    expect(screen.getByText('zone-a / 0')).toBeInTheDocument();
    expect(screen.getByText(/503/)).toBeInTheDocument();
    expect(screen.getByText('power')).toBeInTheDocument();
    expect(screen.getByText('欠損')).toBeInTheDocument();
  });

  // 適応: 選択肢はmodel.refIds基準になったため、0系列クエリのrefIdはMetricInfoを持たない。
  // その場合でもrefIdを名前として欠損表示する(ディスパッチ指示のガード)。
  it('lists a configured refId without MetricInfo as missing', () => {
    const infos = buildMetricInfos([frames[0]], theme, 'browser'); // Aのみ。Bは0系列でMetricInfoなし
    const cell = {
      path: ['zone-a', '0'],
      labels: { zone: 'zone-a' },
      values: new Map<string, number | null>([
        ['A', 503],
        ['B', null],
      ]),
    };
    render(<CellTooltip cell={cell} metricInfos={infos} missingColor="#444" x={0} y={0} />);
    expect(screen.getByText('power')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument(); // MetricInfoが無いrefIdは名前をrefIdにフォールバック
    expect(screen.getByText('欠損')).toBeInTheDocument();
  });
});
