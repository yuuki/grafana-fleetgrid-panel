import { createTheme, DisplayValue } from '@grafana/data';
import { MetricInfo } from '../data/display';
import { LayoutResult } from '../layout/layout';
import { CellModel } from '../types';
import { renderCanvas, RenderContext } from './renderer';

const theme = createTheme();

const makeInfo = (refId: string, spy: jest.Mock): MetricInfo => ({
  refId,
  name: refId === 'A' ? 'power' : refId,
  effectiveMin: 0,
  effectiveMax: 1,
  minConfigured: false,
  maxConfigured: false,
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
    // 'B' has 0 series and isn't present in metricInfos. The old implementation used to fall back to metricInfos[0]('A').
    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', spy)], selectedRefId: 'B' }));
    expect(spy).not.toHaveBeenCalled();
    const styles = fillStyles(canvas);
    expect(styles).toContain('#123456'); // Filled with the missing color
    expect(styles).not.toContain('#abcdef'); // Doesn't use the first metric's color
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
    // Only A has data; B has 0 series and isn't in metricInfos. Even with B selected, split draws A across the whole cell regardless of selection
    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', spy)], selectedRefId: 'B', displayMode: 'split' }));
    expect(spy).toHaveBeenCalledWith(1); // Goes through A's processor rather than the missing color
    const styles = fillStyles(canvas);
    expect(styles).toContain('#abcdef'); // Rendered with A's color (matches the legend "1: A")
    expect(styles).not.toContain('#123456'); // Doesn't fill the whole cell with the missing color
    const rects = fillRects(canvas);
    expect(rects).toEqual([{ x: 0, y: 0, width: 39.5, height: 39.5 }]); // splitRects(1)=full cell (40x40 cell)
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
    // splitRects(2)=split left/right. In a 40x40 cell, each zone has half the x/width, with -0.5 for the grout included in width/height
    expect(fillRects(canvas)).toEqual([
      { x: 0, y: 0, width: 19.5, height: 39.5 },
      { x: 20, y: 0, width: 19.5, height: 39.5 },
    ]);
    const styles = fillStyles(canvas);
    expect(styles).toContain('#aaaaaa'); // Zone 1: A
    expect(styles).toContain('#bbbbbb'); // Zone 2: B
  });
});
