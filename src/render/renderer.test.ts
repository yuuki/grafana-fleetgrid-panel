import { createTheme, DisplayValue } from '@grafana/data';
import { MetricInfo } from '../data/display';
import { LayoutResult } from '../layout/layout';
import { CellModel, CellRangeInfo } from '../types';
import { CategoryModel } from '../data/categories';
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
  categoryStyle: 'border',
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

const canvasEvents = (canvas: HTMLCanvasElement): Array<{ type: string; props: Record<string, unknown> }> =>
  (
    canvas.getContext('2d') as unknown as { __getEvents(): Array<{ type: string; props: Record<string, unknown> }> }
  ).__getEvents();

describe('renderCanvas', () => {
  const cellRange = (processor: jest.Mock): CellRangeInfo => ({
    effectiveMin: 0,
    effectiveMax: 100,
    minConfigured: true,
    maxConfigured: true,
    processor: processor as unknown as CellRangeInfo['processor'],
    source: 'override',
  });

  it.each(['single', 'split'] as const)('uses the cell range processor in %s mode', (displayMode) => {
    const standard = jest.fn((v: number): DisplayValue => ({ numeric: v, text: `standard ${v}`, color: '#111111' }));
    const zoneA = jest.fn((v: number): DisplayValue => ({ numeric: v, text: `zone-a ${v}`, color: '#abcdef' }));
    const zoneB = jest.fn((v: number): DisplayValue => ({ numeric: v, text: `zone-b ${v}`, color: '#fedcba' }));
    const layout = makeLayout([['A', 1]]);
    layout.cells[0].cell.ranges = new Map([['A', cellRange(zoneA)]]);
    layout.cells.push({
      ...layout.cells[0],
      x: 41,
      cell: {
        ...layout.cells[0].cell,
        path: ['b'],
        values: new Map([['A', 1]]),
        ranges: new Map([['A', cellRange(zoneB)]]),
      },
    });
    layout.contentWidth = 81;
    const canvas = document.createElement('canvas');

    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', standard)], layout, displayMode, showValues: true }));

    expect(zoneA).toHaveBeenCalledWith(1);
    expect(zoneB).toHaveBeenCalledWith(1);
    expect(standard).not.toHaveBeenCalled();
    expect(fillStyles(canvas)).toContain('#abcdef');
    expect(fillStyles(canvas)).toContain('#fedcba');
  });

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

  it.each(['single', 'split'] as const)('draws a category border after metric fills in %s mode', (displayMode) => {
    const canvas = document.createElement('canvas');
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const layout = makeLayout([
      ['A', 1],
      ['B', 2],
    ]);
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);

    const processor = jest.fn((value: number): DisplayValue => ({
      numeric: value,
      text: String(value),
      color: '#000000',
    }));
    renderCanvas(
      canvas,
      baseCtx({
        metricInfos: [makeInfo('A', processor), makeInfo('B', processor)],
        layout,
        displayMode,
        category,
        categoryStyle: 'border',
      })
    );

    const events = canvasEvents(canvas);
    expect(events.filter((event) => event.type === 'strokeRect')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'strokeRect')[0].props).toMatchObject({
      x: 1,
      y: 1,
      width: 38,
      height: 38,
    });
  });

  it('draws a top bar with the expected height and skips uncategorized cells', () => {
    const canvas = document.createElement('canvas');
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const layout = makeLayout([
      ['A', 1],
      ['B', null],
    ]);
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    layout.cells.push({ x: 41, y: 0, w: 40, h: 40, cell: { ...layout.cells[0].cell, labelValues: undefined } });

    const processor = jest.fn((value: number): DisplayValue => ({
      numeric: value,
      text: String(value),
      color: '#000000',
    }));
    renderCanvas(
      canvas,
      baseCtx({ metricInfos: [makeInfo('A', processor)], layout, category, categoryStyle: 'topBar' })
    );

    expect(fillRects(canvas)).toContainEqual({ x: 0, y: 0, width: 40, height: 8 });
    expect(fillRects(canvas)).not.toContainEqual({ x: 41, y: 0, width: 40, height: 8 });
  });

  it('uses a one-pixel border for small cells and two pixels for larger cells', () => {
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const canvas = document.createElement('canvas');
    const layout = makeLayout([['A', 1]]);
    layout.cells[0].w = 10;
    layout.cells[0].h = 10;
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    const processor = jest.fn((value: number): DisplayValue => ({
      numeric: value,
      text: String(value),
      color: '#000000',
    }));
    renderCanvas(
      canvas,
      baseCtx({ metricInfos: [makeInfo('A', processor)], layout, category, categoryStyle: 'border' })
    );
    expect(
      canvasEvents(canvas)
        .filter((event) => event.type === 'lineWidth')
        .map((event) => event.props.value)
    ).toContain(1);

    const largeCanvas = document.createElement('canvas');
    const largeLayout = makeLayout([['A', 1]]);
    largeLayout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    renderCanvas(
      largeCanvas,
      baseCtx({ metricInfos: [makeInfo('A', processor)], layout: largeLayout, category, categoryStyle: 'border' })
    );
    expect(
      canvasEvents(largeCanvas)
        .filter((event) => event.type === 'lineWidth')
        .map((event) => event.props.value)
    ).toContain(2);
  });

  it('dims non-matching cells, keeps matching multi-value cells bright, and leaves empty selections unchanged', () => {
    const category: CategoryModel = {
      label: 'partition',
      values: ['a', 'b'],
      colorByValue: new Map([
        ['a', '#f00'],
        ['b', '#00f'],
      ]),
    };
    const layout = makeLayout([['A', 1]]);
    layout.cells[0].cell.labelValues = new Map([['partition', ['a', 'b']]]);
    layout.cells.push({
      x: 41,
      y: 0,
      w: 40,
      h: 40,
      cell: { ...layout.cells[0].cell, labelValues: new Map([['partition', ['c']]]) },
    });
    const processor = jest.fn((value: number): DisplayValue => ({ numeric: value, text: String(value), color: '#000000' }));
    const canvas = document.createElement('canvas');

    renderCanvas(
      canvas,
      baseCtx({ metricInfos: [makeInfo('A', processor)], layout, category, selectedCategoryValues: ['b'] })
    );

    const alphaValues = canvasEvents(canvas)
      .filter((event) => event.type === 'globalAlpha')
      .map((event) => event.props.value);
    expect(alphaValues).toContain(0.22);
    expect(alphaValues).toContain(1);

    const emptySelectionCanvas = document.createElement('canvas');
    renderCanvas(
      emptySelectionCanvas,
      baseCtx({ metricInfos: [makeInfo('A', processor)], layout, category, selectedCategoryValues: [] })
    );
    expect(
      canvasEvents(emptySelectionCanvas)
        .filter((event) => event.type === 'globalAlpha')
        .map((event) => event.props.value)
    ).not.toContain(0.22);

    const noCategoryCanvas = document.createElement('canvas');
    renderCanvas(
      noCategoryCanvas,
      baseCtx({ metricInfos: [makeInfo('A', processor)], layout, selectedCategoryValues: ['b'] })
    );
    expect(
      canvasEvents(noCategoryCanvas)
        .filter((event) => event.type === 'globalAlpha')
        .map((event) => event.props.value)
    ).not.toContain(0.22);
  });
});
