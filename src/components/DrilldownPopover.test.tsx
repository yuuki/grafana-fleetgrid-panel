import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos } from '../data/display';
import { DrilldownPopover } from './DrilldownPopover';

jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
}));

const theme = createTheme();
const rangeFrame = toDataFrame({
  refId: 'A',
  name: 'power',
  fields: [
    { name: 'Time', type: FieldType.time, values: [1000, 2000] },
    { name: 'Value', type: FieldType.number, values: [500, 503], labels: { zone: 'zone-a' } },
  ],
});

describe('DrilldownPopover', () => {
  const cell = { path: ['zone-a'], labels: { zone: 'zone-a' }, values: new Map<string, number | null>([['A', 503]]) };
  const bounds = { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  it('renders a sparkline row per metric', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: rangeFrame, seriesCount: 1, aggregated: false })} loading={false} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('zone-a')).toBeInTheDocument();
    expect(screen.getByText('power')).toBeInTheDocument();
    expect(screen.getByTestId('sparkline')).toBeInTheDocument();
  });
  it('shows loading state', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: null, seriesCount: 0, aggregated: false })} loading={true} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
  });
  it('labels aggregated multi-series rows', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: rangeFrame, seriesCount: 3, aggregated: true })} loading={false} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('power (3系列を集約)')).toBeInTheDocument();
  });
  it('labels non-aggregated fallback multi-series rows precisely', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: rangeFrame, seriesCount: 3, aggregated: false })} loading={false} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('power (3系列中の先頭を表示)')).toBeInTheDocument();
  });
});
