import React from 'react';
import { render, screen } from '@testing-library/react';
import { createTheme, FieldType, toDataFrame } from '@grafana/data';
import { buildMetricInfos, MetricInfo } from '../data/display';
import { RangeLegend, rangeStateLabel } from './RangeLegend';

let mockTheme = createTheme();
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  useTheme2: () => mockTheme,
}));

const metricInfo = (minConfigured: boolean, maxConfigured: boolean): MetricInfo => ({
  refId: 'A',
  name: 'GPU Utilization',
  effectiveMin: 0,
  effectiveMax: 100,
  minConfigured,
  maxConfigured,
  processor: ((value: number) => ({
    text: value.toFixed(1),
    suffix: '%',
    numeric: value,
    color: `rgb(${Math.round(value)}, 0, 0)`,
  })) as MetricInfo['processor'],
  field: {} as MetricInfo['field'],
  frame: {} as MetricInfo['frame'],
});

describe('RangeLegend', () => {
  it.each([
    [true, true, 'Fixed'],
    [false, false, 'Auto'],
    [true, false, 'Min fixed'],
    [false, true, 'Max fixed'],
  ])('derives the range state from explicitly configured endpoints', (min, max, label) => {
    expect(rangeStateLabel(metricInfo(min, max))).toBe(label);
  });

  it('renders the full legend at 480px with formatted endpoints and 33 processor colors', () => {
    render(<RangeLegend metricInfo={metricInfo(true, true)} width={480} />);
    expect(screen.getByText('GPU Utilization')).toBeInTheDocument();
    expect(screen.getByText('Fixed')).toBeInTheDocument();
    expect(screen.getByText('0.0%')).toBeInTheDocument();
    expect(screen.getByText('100.0%')).toBeInTheDocument();
    const gradient = screen.getByTestId('range-gradient').style.background;
    expect(gradient.match(/rgb\(/g)).toHaveLength(33);
  });

  it('renders a compact accessible badge below 480px', () => {
    render(<RangeLegend metricInfo={metricInfo(true, false)} width={479} />);
    expect(screen.getByLabelText('GPU Utilization range, Min fixed, 0.0% to 100.0%')).toHaveTextContent('0.0%–100.0%');
    expect(screen.queryByTestId('range-gradient')).not.toBeInTheDocument();
    expect(screen.queryByText('Min fixed')).not.toBeInTheDocument();
  });

  it.each([
    ['light', 480],
    ['light', 479],
    ['dark', 480],
    ['dark', 479],
  ] as const)('uses Grafana %s theme tokens at %ipx', (mode, width) => {
    mockTheme = createTheme({ colors: { mode } } as any);
    render(<RangeLegend metricInfo={metricInfo(true, true)} width={width} />);
    const legend = screen.getByTestId('range-legend');
    expect(legend).toHaveStyle({
      color: mockTheme.colors.text.primary,
      background: mockTheme.colors.background.secondary,
      border: `1px solid ${mockTheme.colors.border.medium}`,
    });
    const secondary =
      width < 480 ? legend.querySelector('[aria-hidden]') : screen.getByText('Fixed');
    expect(secondary).toHaveStyle({ color: mockTheme.colors.text.secondary });
  });

  it('does not process the range again when rerendered with the same MetricInfo', () => {
    const info = metricInfo(true, true);
    info.processor = jest.fn(info.processor) as MetricInfo['processor'];
    const { rerender } = render(<RangeLegend metricInfo={info} width={480} />);
    const callsAfterFirstRender = (info.processor as jest.Mock).mock.calls.length;

    rerender(<RangeLegend metricInfo={info} width={480} />);

    expect((info.processor as jest.Mock).mock.calls).toHaveLength(callsAfterFirstRender);
  });

  it('only processes the two endpoints in compact mode', () => {
    const info = metricInfo(true, true);
    info.processor = jest.fn(info.processor) as MetricInfo['processor'];
    render(<RangeLegend metricInfo={info} width={479} />);
    expect(info.processor).toHaveBeenCalledTimes(2);
  });

  it('passes only finite endpoints and gradient samples to the processor', () => {
    const [info] = buildMetricInfos(
      [
        toDataFrame({
          refId: 'A',
          name: 'extreme',
          fields: [{ name: 'Value', type: FieldType.number, values: [-Number.MAX_VALUE, Number.MAX_VALUE] }],
        }),
      ],
      mockTheme,
      'browser'
    );
    info.processor = jest.fn(info.processor) as MetricInfo['processor'];
    render(<RangeLegend metricInfo={info} width={480} />);
    const inputs = (info.processor as jest.Mock).mock.calls.map(([value]) => value);
    expect(inputs).toHaveLength(35);
    expect(inputs.every(Number.isFinite)).toBe(true);
  });
});
