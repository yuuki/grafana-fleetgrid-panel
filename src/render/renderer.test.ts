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

const fillRects = (canvas: HTMLCanvasElement): Array<{ x: number; y: number; width: number; height: number }> =>
  (
    canvas.getContext('2d') as unknown as {
      __getEvents(): Array<{ type: string; props: { x: number; y: number; width: number; height: number } }>;
    }
  )
    .__getEvents()
    .filter((e) => e.type === 'fillRect')
    .map((e) => e.props);

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

  it('draws the sole MetricInfo across the whole cell in split mode even if a zero-series refId is selected', () => {
    const spy = jest.fn((v: number): DisplayValue => ({ numeric: v, text: String(v), color: '#abcdef' }));
    const canvas = document.createElement('canvas');
    // A のみデータ、B は0系列で metricInfos に無い。B選択済みでも split では選択に依らず A を全面に描く
    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', spy)], selectedRefId: 'B', displayMode: 'split' }));
    expect(spy).toHaveBeenCalledWith(1); // 欠損色ではなく A の processor を通す
    const styles = fillStyles(canvas);
    expect(styles).toContain('#abcdef'); // A の色で描画(凡例「1: A」と一致)
    expect(styles).not.toContain('#123456'); // 欠損色で全面を塗らない
    const rects = fillRects(canvas);
    expect(rects).toEqual([{ x: 0, y: 0, width: 39.5, height: 39.5 }]); // splitRects(1)=全面(40x40セル)
  });

  it('splits a cell into per-metric regions using splitRects geometry in split mode', () => {
    const a = jest.fn((v: number): DisplayValue => ({ numeric: v, text: String(v), color: '#aaaaaa' }));
    const b = jest.fn((v: number): DisplayValue => ({ numeric: v, text: String(v), color: '#bbbbbb' }));
    const canvas = document.createElement('canvas');
    renderCanvas(
      canvas,
      baseCtx({
        metricInfos: [makeInfo('A', a), makeInfo('B', b)],
        displayMode: 'split',
        layout: makeLayout([
          ['A', 1],
          ['B', 2],
        ]),
      })
    );
    // splitRects(2)=左右2分割。40x40セルで各区画は x/幅がハーフ、幅高は-0.5の目地込み
    expect(fillRects(canvas)).toEqual([
      { x: 0, y: 0, width: 19.5, height: 39.5 },
      { x: 20, y: 0, width: 19.5, height: 39.5 },
    ]);
    const styles = fillStyles(canvas);
    expect(styles).toContain('#aaaaaa'); // 区画1: A
    expect(styles).toContain('#bbbbbb'); // 区画2: B
  });
});
