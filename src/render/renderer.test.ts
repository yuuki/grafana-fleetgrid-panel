import { createTheme, DisplayValue } from '@grafana/data';
import { MetricInfo } from '../data/display';
import { LayoutResult } from '../layout/layout';
import { CellModel } from '../types';
import { renderCanvas, RenderContext } from './renderer';

const theme = createTheme();

const makeInfo = (refId: string, spy: jest.Mock): MetricInfo => ({
  refId,
  name: refId === 'A' ? 'power' : refId,
  processor: spy as unknown as MetricInfo['processor'],
  field: {} as MetricInfo['field'],
  frame: {} as MetricInfo['frame'],
});

const makeLayout = (values: Array<[string, number | null]>): LayoutResult => {
  const cell: CellModel = { path: ['a'], labels: {}, values: new Map(values) };
  return {
    cells: [{ x: 0, y: 0, w: 40, h: 40, cell }],
    labels: [],
    borders: [],
    cellSize: 40,
    contentWidth: 40,
    contentHeight: 40,
    scrollable: false,
  };
};

const baseCtx = (over: Partial<RenderContext>): RenderContext => ({
  layout: makeLayout([
    ['A', 1],
    ['B', null],
  ]),
  metricInfos: [],
  selectedRefId: 'A',
  displayMode: 'single',
  showValues: false,
  missingColor: '#123456',
  theme,
  scrollTop: 0,
  viewportH: 40,
  ...over,
});

const fillStyles = (canvas: HTMLCanvasElement): string[] =>
  (canvas.getContext('2d') as unknown as { __getEvents(): Array<{ type: string; props: { value: string } }> })
    .__getEvents()
    .filter((e) => e.type === 'fillStyle')
    .map((e) => e.props.value);

describe('renderCanvas', () => {
  it('renders a selected zero-series refId as missing without falling back to another metric', () => {
    const spy = jest.fn((v: number): DisplayValue => ({ numeric: v, text: String(v), color: '#abcdef' }));
    const canvas = document.createElement('canvas');
    // 'B' は0系列で metricInfos に存在しない。旧実装は metricInfos[0]('A') にフォールバックしていた。
    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', spy)], selectedRefId: 'B' }));
    expect(spy).not.toHaveBeenCalled();
    const styles = fillStyles(canvas);
    expect(styles).toContain('#123456'); // 欠損色で塗る
    expect(styles).not.toContain('#abcdef'); // 先頭メトリクスの色は使わない
  });

  it('uses the metric processor color when its own refId is selected', () => {
    const spy = jest.fn((v: number): DisplayValue => ({ numeric: v, text: String(v), color: '#abcdef' }));
    const canvas = document.createElement('canvas');
    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', spy)], selectedRefId: 'A' }));
    expect(spy).toHaveBeenCalledWith(1);
    expect(fillStyles(canvas)).toContain('#abcdef');
  });
});
