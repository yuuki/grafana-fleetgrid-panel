import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';
import { buildMetricInfos } from '../data/display';
import { CellTooltip } from './CellTooltip';
import { CellRangeInfo } from '../types';

jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  useTheme2: jest.fn(),
}));

const theme = createTheme();
const mockUseTheme2 = jest.mocked(useTheme2);
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
  beforeEach(() => {
    mockUseTheme2.mockReturnValue(theme);
  });

  it('uses the current theme for its surface', () => {
    const infos = buildMetricInfos([frames[0]], theme, 'browser');
    const cell = {
      path: ['zone-a', '0'],
      labels: { zone: 'zone-a' },
      values: new Map<string, number | null>([['A', 503]]),
    };
    render(<CellTooltip cell={cell} metricInfos={infos} missingColor="#444" x={0} y={0} />);

    expect(screen.getByText('zone-a / 0').parentElement).toHaveStyle({
      background: theme.colors.background.elevated ?? theme.colors.background.secondary,
      color: theme.colors.text.primary,
      border: `1px solid ${theme.colors.border.medium}`,
      boxShadow: theme.shadows.z3,
    });
  });

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
    expect(screen.getByText(/^503\s*W$/)).toBeInTheDocument(); // Formatted result with unit (not the raw value)
    expect(screen.getByText('power')).toBeInTheDocument();
    expect(screen.getByText('temp')).toBeInTheDocument(); // Name of the second metric
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('Standard range')).toBeInTheDocument();
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('is focusable and keeps pointer movement from escaping to the panel', () => {
    const infos = buildMetricInfos([frames[0]], theme, 'browser');
    const cell = { path: ['zone-a'], labels: {}, values: new Map<string, number | null>([['A', 503]]) };
    const onMouseMove = jest.fn();
    const onPointerMove = jest.fn();
    render(
      <div onMouseMove={onMouseMove} onPointerMove={onPointerMove}>
        <CellTooltip cell={cell} metricInfos={infos} missingColor="#444" x={0} y={0} />
      </div>
    );
    const tooltip = screen.getByRole('tooltip', { name: 'zone-a details' });
    expect(tooltip).toHaveStyle({ pointerEvents: 'auto' });
    expect(tooltip).toHaveAttribute('tabindex', '0');
    tooltip.focus();
    expect(tooltip).toHaveFocus();
    fireEvent.mouseMove(tooltip);
    fireEvent.pointerMove(tooltip);
    expect(onMouseMove).not.toHaveBeenCalled();
    expect(onPointerMove).not.toHaveBeenCalled();
  });

  it('uses the cell processor and describes the applied label range', () => {
    const infos = buildMetricInfos([frames[0]], theme, 'browser');
    const processor = jest.fn((value: number) => ({
      text: `${value / 1000}`,
      suffix: ' kW',
      numeric: value,
      color: '#abc',
    }));
    const range: CellRangeInfo = {
      effectiveMin: 0,
      effectiveMax: 700,
      minConfigured: true,
      maxConfigured: true,
      processor: processor as CellRangeInfo['processor'],
      source: 'override',
      matchers: [
        { label: 'zone', operator: 'exact', value: 'zone-a' },
        { label: 'bw_type', operator: 'regex', value: '^NVLink ' },
      ],
    };
    const cell = {
      path: ['zone-a', '0'],
      labels: { zone: 'zone-a' },
      values: new Map<string, number | null>([['A', 503]]),
      ranges: new Map([['A', range]]),
    };

    render(<CellTooltip cell={cell} metricInfos={infos} missingColor="#444" x={0} y={0} />);

    expect(processor).toHaveBeenCalledWith(503);
    expect(screen.getByText('0 kW–0.7 kW')).toBeInTheDocument();
    expect(screen.getByText('Fixed')).toBeInTheDocument();
    expect(screen.getByText('zone = zone-a')).toBeInTheDocument();
    expect(screen.getByText(/^bw_type =~ \^NVLink/)).toBeInTheDocument();
  });

  it('labels conflict fallback as the standard range', () => {
    const infos = buildMetricInfos([frames[0]], theme, 'browser');
    const range: CellRangeInfo = {
      effectiveMin: infos[0].effectiveMin,
      effectiveMax: infos[0].effectiveMax,
      minConfigured: false,
      maxConfigured: false,
      processor: infos[0].processor,
      source: 'conflict',
    };
    const cell = {
      path: ['zone-a'],
      labels: { zone: 'zone-a' },
      values: new Map<string, number | null>([['A', 503]]),
      ranges: new Map([['A', range]]),
    };

    render(<CellTooltip cell={cell} metricInfos={infos} missingColor="#444" x={0} y={0} />);

    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('Standard range (override conflict)')).toBeInTheDocument();
  });

  it('flips and clamps within scrolled visible bounds', () => {
    const infos = buildMetricInfos([frames[0]], theme, 'browser');
    const cell = { path: ['zone-a'], labels: {}, values: new Map<string, number | null>([['A', 503]]) };
    const bounds = { minX: 200, minY: 150, maxX: 500, maxY: 330 };
    render(<CellTooltip cell={cell} metricInfos={infos} missingColor="#444" x={490} y={320} {...bounds} />);
    const tooltip = screen.getByText('zone-a').parentElement as HTMLElement;
    expect(parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(bounds.minX);
    expect(parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(bounds.minY);
    expect(parseFloat(tooltip.style.left) + parseFloat(tooltip.style.width)).toBeLessThanOrEqual(bounds.maxX);
    expect(parseFloat(tooltip.style.top) + parseFloat(tooltip.style.maxHeight)).toBeLessThanOrEqual(bounds.maxY);
    expect(tooltip.style.boxSizing).toBe('border-box');
  });

  it('wraps long regex matchers and scrolls bounded content', () => {
    const infos = buildMetricInfos([frames[0]], theme, 'browser');
    const range: CellRangeInfo = {
      effectiveMin: 0,
      effectiveMax: 700,
      minConfigured: true,
      maxConfigured: true,
      processor: infos[0].processor,
      source: 'override',
      matchers: [{ label: 'bw_type', operator: 'regex', value: '^' + 'NVLink-'.repeat(30) }],
    };
    const cell = {
      path: ['zone-a'],
      labels: {},
      values: new Map<string, number | null>([['A', 503]]),
      ranges: new Map([['A', range]]),
    };
    render(
      <CellTooltip
        cell={cell}
        metricInfos={infos}
        missingColor="#444"
        x={10}
        y={10}
        minX={0}
        minY={0}
        maxX={180}
        maxY={80}
      />
    );
    const matcher = screen.getByText(/^bw_type =~/);
    const tooltip = screen.getByText('zone-a').parentElement as HTMLElement;
    expect(matcher).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(tooltip.style.overflowY).toBe('auto');
    expect(parseFloat(tooltip.style.maxWidth)).toBeLessThanOrEqual(180);
    expect(parseFloat(tooltip.style.maxHeight)).toBeLessThanOrEqual(80);
  });

  // Adaptation: since choices are now based on model.refIds, a refId with 0 series has no MetricInfo.
  // Even in that case, show it as missing using the refId as the name (guard per dispatch instructions).
  it('lists a configured refId without MetricInfo as missing', () => {
    const infos = buildMetricInfos([frames[0]], theme, 'browser'); // A only. B has 0 series and no MetricInfo
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
    expect(screen.getByText('B')).toBeInTheDocument(); // A refId without MetricInfo falls back to using the refId as its name
    expect(screen.getByText('No data')).toBeInTheDocument();
  });
});
