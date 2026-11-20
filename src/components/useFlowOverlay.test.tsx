import { renderHook } from '@testing-library/react';
import { FieldType, LoadingState, PanelData, getDefaultTimeRange, toDataFrame } from '@grafana/data';
import { FlowModel } from '../data/edges';
import { DEFAULT_LEVEL, FleetGridOptions } from '../types';
import { useCellQueries, withFlowWarnings } from './useFlowOverlay';

const frame = (refId?: string) =>
  toDataFrame({ refId, fields: [{ name: 'Value', type: FieldType.number, values: [1], labels: { host: 'node-a1' } }] });

const panelData = (refIds: Array<string | undefined>): PanelData => ({
  series: refIds.map(frame),
  state: LoadingState.Done,
  timeRange: getDefaultTimeRange(),
  request: {
    requestId: 'Q1',
    targets: refIds.filter((refId) => refId !== undefined).map((refId) => ({ refId, instant: true })),
  } as unknown as PanelData['request'],
});

const options = (over: Partial<FleetGridOptions> = {}): FleetGridOptions => ({
  levels: [{ ...DEFAULT_LEVEL, label: 'host' }],
  displayMode: 'single',
  showValues: true,
  missingColor: '#444',
  spatialAggregation: 'max',
  reduceCalc: 'lastNotNull',
  ...over,
});

describe('useCellQueries', () => {
  it('returns the frames and the request themselves while no edge query is named', () => {
    const data = panelData(['A', 'E']);
    const { result } = renderHook(() => useCellQueries(data, options()));
    expect(result.current.series).toBe(data.series);
    expect(result.current.request).toBe(data.request);
    expect(result.current.targetRefIds).toEqual(['A', 'E']);
  });

  it('leaves the edge query out of the frames, the target refIds and the request', () => {
    const data = panelData(['A', 'E', 'B']);
    const { result } = renderHook(() => useCellQueries(data, options({ flowRefId: 'E' })));
    expect(result.current.series.map((f) => f.refId)).toEqual(['A', 'B']);
    expect(result.current.targetRefIds).toEqual(['A', 'B']);
    expect(result.current.request!.targets.map((t) => t.refId)).toEqual(['A', 'B']);
    expect(result.current.request!.requestId).toBe('Q1');
    // The panel's own request is not changed.
    expect(data.request!.targets).toHaveLength(3);
  });

  it('counts a frame without a refId as query A, like the cell pipeline', () => {
    const data = panelData([undefined, 'B']);
    const { result } = renderHook(() => useCellQueries(data, options({ flowRefId: 'A' })));
    expect(result.current.series.map((f) => f.refId)).toEqual(['B']);
  });

  it('works without a request', () => {
    const data = { ...panelData(['A', 'E']), request: undefined };
    const { result } = renderHook(() => useCellQueries(data, options({ flowRefId: 'E' })));
    expect(result.current.request).toBeUndefined();
    expect(result.current.targetRefIds).toEqual([]);
  });

  it('keeps its results while its inputs are the same', () => {
    const data = panelData(['A', 'E']);
    const opts = options({ flowRefId: 'E' });
    const { result, rerender } = renderHook(() => useCellQueries(data, opts));
    const first = result.current;
    rerender();
    expect(result.current.series).toBe(first.series);
    expect(result.current.request).toBe(first.request);
    expect(result.current.targetRefIds).toBe(first.targetRefIds);
  });
});

describe('withFlowWarnings', () => {
  const cellWarnings = ['1/2 rows did not match the hierarchy and were excluded'];

  it('returns the cell warnings themselves when the overlay adds none', () => {
    expect(withFlowWarnings(cellWarnings, null)).toBe(cellWarnings);
    expect(withFlowWarnings(cellWarnings, { warnings: [] } as unknown as FlowModel)).toBe(cellWarnings);
  });

  it('appends the flow warnings', () => {
    const flow = { warnings: ['Flow overlay: query "E" returned no rows'] } as unknown as FlowModel;
    expect(withFlowWarnings(cellWarnings, flow)).toEqual([...cellWarnings, ...flow.warnings]);
  });
});
