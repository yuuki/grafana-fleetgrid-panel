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
    const popover = screen.getByText('zone-a').parentElement!.parentElement as HTMLElement;
    expect(popover.style.maxHeight).toBe('74px');
    expect(popover.style.overflowY).toBe('');
  });
  it('shows loading state', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: null, seriesCount: 0, aggregated: false })} loading={true} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
  it('shows a re-query failure message when error is set and no series is available', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: null, seriesCount: 0, aggregated: false })} loading={false} error={true} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('Failed to load time series')).toBeInTheDocument();
    expect(screen.queryByText('No time series')).not.toBeInTheDocument();
  });
  it('prefers loading over error while a fetch is in flight', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: null, seriesCount: 0, aggregated: false })} loading={true} error={true} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load time series')).not.toBeInTheDocument();
  });
  it('labels aggregated multi-series rows', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: rangeFrame, seriesCount: 3, aggregated: true })} loading={false} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('power (aggregating 3 series)')).toBeInTheDocument();
  });
  it('labels non-aggregated fallback multi-series rows precisely', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover cell={cell} metricInfos={infos} seriesFor={() => ({ frame: rangeFrame, seriesCount: 3, aggregated: false })} loading={false} x={0} y={0} {...bounds} onClose={() => {}} />
    );
    expect(screen.getByText('power (showing first of 3 series)')).toBeInTheDocument();
  });
  it('clamps a flipped popover within a scrolled (non-zero) visible range', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    // Narrow visible range after scrolling. Clicking near the bottom-right flips to top-left; a naive x-W-8 would fall below minX.
    const minX = 200;
    const minY = 150;
    const maxX = 500; // Width is the same as the internal W(300) → clamping is required
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
    const W = 300; // DrilldownPopover's internal fixed width
    const h = 40 + infos.length * 34; // Internal height calculation (header 40 + rowCount*ROW_H)
    // The top-left corner is within the visible range. With a fixed clamp of 0, left=172 < minX would fail this assertion.
    expect(left).toBeGreaterThanOrEqual(minX);
    expect(top).toBeGreaterThanOrEqual(minY);
    // The bottom-right corner (left+width / top+height) also fits within the visible range
    expect(left + W).toBeLessThanOrEqual(maxX);
    expect(top + h).toBeLessThanOrEqual(maxY);
  });

  it('caps tall content to the visible height and enables internal scrolling', () => {
    const [baseInfo] = buildMetricInfos([rangeFrame], theme, 'browser');
    const infos = Array.from({ length: 8 }, (_, i) => ({
      ...baseInfo,
      refId: `metric-${i}`,
      name: `metric-${i}`,
    }));
    const shortBounds = { minX: 0, minY: 20, maxX: 800, maxY: 120 };

    render(
      <DrilldownPopover
        cell={cell}
        metricInfos={infos}
        seriesFor={() => ({ frame: rangeFrame, seriesCount: 1, aggregated: false })}
        loading={false}
        x={0}
        y={100}
        {...shortBounds}
        onClose={() => {}}
      />
    );

    const popover = screen.getByText('zone-a').parentElement!.parentElement as HTMLElement;
    const availableH = shortBounds.maxY - shortBounds.minY;
    expect(popover.style.maxHeight).toBe(`${availableH}px`);
    expect(popover.style.overflowY).toBe('auto');
    expect(popover.style.boxSizing).toBe('border-box');
    expect(parseFloat(popover.style.top) + availableH).toBeLessThanOrEqual(shortBounds.maxY);
  });

  it('collapses safely when the visible height is zero', () => {
    const infos = buildMetricInfos([rangeFrame], theme, 'browser');
    render(
      <DrilldownPopover
        cell={cell}
        metricInfos={infos}
        seriesFor={() => ({ frame: rangeFrame, seriesCount: 1, aggregated: false })}
        loading={false}
        x={0}
        y={100}
        minX={0}
        minY={100}
        maxX={800}
        maxY={100}
        onClose={() => {}}
      />
    );

    const popover = screen.getByText('zone-a').parentElement!.parentElement as HTMLElement;
    expect(popover.style.maxHeight).toBe('0px');
    expect(popover.style.padding).toBe('0px');
    expect(popover.style.borderWidth).toBe('0px');
  });
});
