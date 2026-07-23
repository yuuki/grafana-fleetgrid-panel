import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos, MetricInfo } from '../data/display';
import { splitRects } from '../render/split';
import { SplitLegend } from './SplitLegend';
import { CellRangeInfo } from '../types';

const theme = createTheme();
let mockTheme = theme;
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  useTheme2: () => mockTheme,
}));
const frame = (refId: string, name: string, config = {}) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1] },
      { name: 'Value', type: FieldType.number, values: [1], config, labels: {} },
    ],
  });

describe('SplitLegend', () => {
  it('shows a label-based range count for a metric with multiple actually-used signatures', () => {
    const infos = buildMetricInfos([frame('A', 'power')], theme, 'browser');
    const cellRange = (max: number): CellRangeInfo => ({
      effectiveMin: 0,
      effectiveMax: max,
      minConfigured: true,
      maxConfigured: true,
      processor: infos[0].processor,
      source: 'override',
    });

    render(<SplitLegend metricInfos={infos} rangeInfosByRef={new Map([['A', [cellRange(500), cellRange(700)]]])} />);

    expect(screen.getByText('Label-based ranges')).toBeInTheDocument();
    expect(screen.getByText('2 ranges')).toBeInTheDocument();
    expect(screen.queryByText(/–/)).not.toBeInTheDocument();
  });

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
    expect(screen.getByText(/up to 9 queries/)).toBeInTheDocument();
    expect(screen.getByText(/2 hidden/)).toBeInTheDocument();
  });
  it('positions each minimap fill to match splitRects percentages', () => {
    const infos = buildMetricInfos([frame('A', 'power'), frame('B', 'temp')], theme, 'browser');
    const { container } = render(<SplitLegend metricInfos={infos} />);
    const rects = splitRects(infos.length);
    // The span directly under the miniature frame (aria-hidden) is the zone fill. Verifies it has the same proportions as splitRects (single source of truth)
    const fills = container.querySelectorAll<HTMLElement>('span[aria-hidden] > span');
    expect(fills).toHaveLength(rects.length);
    fills.forEach((el, i) => {
      expect(el.style.left).toBe(`${rects[i].x * 100}%`);
      expect(el.style.top).toBe(`${rects[i].y * 100}%`);
      expect(el.style.width).toBe(`${rects[i].w * 100}%`);
      expect(el.style.height).toBe(`${rects[i].h * 100}%`);
    });
  });

  it('shows each metric range and fixed state using its display formatting', () => {
    const infos = buildMetricInfos(
      [frame('A', 'power', { min: 0, max: 100, unit: 'percent', decimals: 1 }), frame('B', 'temp')],
      theme,
      'browser'
    );
    render(<SplitLegend metricInfos={infos} />);
    expect(screen.getByText('Fixed')).toBeInTheDocument();
    expect(screen.getByText('0.0%–100.0%')).toBeInTheDocument();
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('uses Grafana %s theme tokens for range badges', (mode) => {
    mockTheme = createTheme({ colors: { mode } } as any);
    const infos = buildMetricInfos([frame('A', 'power', { min: 0, max: 100 })], mockTheme, 'browser');
    render(<SplitLegend metricInfos={infos} />);
    const badge = screen.getByTestId('split-range-badge-A');
    expect(badge).toHaveStyle({
      color: mockTheme.colors.text.primary,
      background: mockTheme.colors.background.secondary,
      border: `1px solid ${mockTheme.colors.border.medium}`,
    });
    expect(within(badge).getByText('Fixed')).toHaveStyle({ color: mockTheme.colors.text.secondary });
  });

  it('does not process endpoints again when rerendered with the same metricInfos reference', () => {
    const infos = buildMetricInfos([frame('A', 'power', { min: 0, max: 100 })], theme, 'browser');
    infos[0].processor = jest.fn(infos[0].processor) as MetricInfo['processor'];
    const { rerender } = render(<SplitLegend metricInfos={infos} />);
    const callsAfterFirstRender = (infos[0].processor as jest.Mock).mock.calls.length;

    rerender(<SplitLegend metricInfos={infos} />);

    expect((infos[0].processor as jest.Mock).mock.calls).toHaveLength(callsAfterFirstRender);
  });
});
