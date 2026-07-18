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
  it('shows a re-query failure message when error is set and no series is available', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: null, seriesCount: 0, aggregated: false })} loading={false} error={true} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('再取得に失敗しました')).toBeInTheDocument();
    expect(screen.queryByText('時系列なし')).not.toBeInTheDocument();
  });
  it('prefers loading over error while a fetch is in flight', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: null, seriesCount: 0, aggregated: false })} loading={true} error={true} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('読み込み中…')).toBeInTheDocument();
    expect(screen.queryByText('再取得に失敗しました')).not.toBeInTheDocument();
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
  it('clamps a flipped popover within a scrolled (non-zero) visible range', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    // スクロール後の狭い可視範囲。右下端付近クリックで左上へ反転し、素朴なx-W-8はminXを下回る。
    const minX = 200;
    const minY = 150;
    const maxX = 500; // 幅は内部W(300)と同じ → クランプ必須
    const maxY = 400;
    render(
      <DrilldownPopover
        cell={cell}
        metricInfos={infos}
        seriesFor={() => ({ frame: rangeFrame, seriesCount: 1, aggregated: false })}
        loading={false}
        x={480}
        y={380}
        minX={minX}
        minY={minY}
        maxX={maxX}
        maxY={maxY}
        onClose={() => {}}
      />
    );
    const popover = screen.getByText('zone-a').parentElement!.parentElement as HTMLElement;
    const left = parseFloat(popover.style.left);
    const top = parseFloat(popover.style.top);
    const W = 300; // DrilldownPopover内部の固定幅
    const h = 40 + infos.length * 34; // 内部の高さ算出(ヘッダ40 + 行数*ROW_H)
    // 左上端が可視範囲内。0固定クランプなら left=172 < minX でこのassertは落ちる。
    expect(left).toBeGreaterThanOrEqual(minX);
    expect(top).toBeGreaterThanOrEqual(minY);
    // 右下端(left+幅 / top+高さ)も可視範囲内に収まる
    expect(left + W).toBeLessThanOrEqual(maxX);
    expect(top + h).toBeLessThanOrEqual(maxY);
  });
});
