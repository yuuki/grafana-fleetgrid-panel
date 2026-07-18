import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FieldType, LoadingState, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL } from '../types';
import { ClusterviewPanel } from './ClusterviewPanel';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelDataErrorView: () => <div>No data</div>,
}));

const series = (refId: string, name: string, zone: string) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: [1000] },
      { name: 'Value', type: FieldType.number, values: [1], labels: { zone } },
    ],
  });

const makeProps = (frames: unknown[]): any => ({
  id: 1,
  width: 400,
  height: 300,
  timeZone: 'browser',
  timeRange: getDefaultTimeRange(),
  data: {
    series: frames,
    state: LoadingState.Done,
    timeRange: getDefaultTimeRange(),
    request: { requestId: 'Q1', targets: (frames as Array<{ refId: string }>).map((f) => ({ refId: f.refId })) },
  },
  options: {
    levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
    displayMode: 'single',
    showValues: true,
    missingColor: '#444',
    spatialAggregation: 'max',
    reduceCalc: 'lastNotNull',
  },
});

describe('ClusterviewPanel', () => {
  it('renders canvas and a metric selector for multiple queries', () => {
    render(<ClusterviewPanel {...makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')])} />);
    expect(document.querySelector('canvas')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('shows warnings when the hierarchy label is absent', () => {
    const p = makeProps([series('A', 'power', 'zone-a')]);
    p.options.levels = [{ ...DEFAULT_LEVEL, label: 'rack' }];
    render(<ClusterviewPanel {...p} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows no-data view when there are no frames', () => {
    render(<ClusterviewPanel {...makeProps([])} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('shows the metric selector when displayMode is unset (defaults to single)', () => {
    const p = makeProps([series('A', 'power', 'zone-a'), series('B', 'temp', 'zone-a')]);
    delete p.options.displayMode;
    render(<ClusterviewPanel {...p} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('uses content coordinates (incl. scrollLeft) for hover hit testing', () => {
    // 同一refId・2ゾーンで横並び2セル(flow, s=40 → zone-a:[0,40), zone-b:[41,81))。refIdは1つなのでヘッダー無し。
    render(<ClusterviewPanel {...makeProps([series('A', 'power', 'zone-a'), series('A', 'power', 'zone-b')])} />);
    const container = document.querySelector('canvas')!.parentElement as HTMLElement;
    // 横スクロール状態(scrollLeft=50)を再現する
    Object.defineProperty(container, 'scrollLeft', { configurable: true, value: 50 });
    // clientX=10 は素朴にはzone-a([0,40))だが、+scrollLeft=50でcx=60 → zone-b([41,81))が正しいヒット
    fireEvent.mouseMove(container, { clientX: 10, clientY: 5 });
    const title = screen.getByText('zone-b'); // scrollLeftを加味した正しいセルがヒットしている
    expect(title).toBeInTheDocument();
    expect(title.parentElement).toHaveStyle({ left: '72px' }); // ツールチップx = cx(60) + 12 = コンテンツ座標
  });

  it('lists refIds for configured queries that returned no series', () => {
    const p = makeProps([series('A', 'power', 'zone-a')]);
    // クエリBは設定済み(targets)だが0系列(seriesには無い)
    p.data.request.targets = [{ refId: 'A' }, { refId: 'B' }];
    render(<ClusterviewPanel {...p} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('power')).toBeInTheDocument(); // Aは系列名
    expect(screen.getByText('B')).toBeInTheDocument(); // BはmetricInfoが無いのでrefId表示
  });
});
