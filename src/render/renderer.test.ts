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
  categoryStyle: 'strip',
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
    // splitRects(1) = the whole 40px cell, minus a 1 device-px grout (dpr=1) on the right/bottom → 39x39.
    expect(rects).toEqual([{ x: 0, y: 0, width: 39, height: 39 }]);
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
    // splitRects(2) = left/right halves. Device-px column edges are 0|20|40; each tile drops a 1px grout on
    // its right/bottom → {0,0,19,39} and {20,0,19,39}.
    expect(fillRects(canvas)).toEqual([
      { x: 0, y: 0, width: 19, height: 39 },
      { x: 20, y: 0, width: 19, height: 39 },
    ]);
    const styles = fillStyles(canvas);
    expect(styles).toContain('#aaaaaa'); // Zone 1: A
    expect(styles).toContain('#bbbbbb'); // Zone 2: B
  });

  const flatProcessor = jest.fn((value: number): DisplayValue => ({ numeric: value, text: String(value), color: '#000000' }));

  it.each(['single', 'split'] as const)(
    'draws the outline as pixel-snapped frame and moat bands (no strokeRect) in %s mode',
    (displayMode) => {
      const canvas = document.createElement('canvas');
      const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
      const layout = makeLayout([
        ['A', 1],
        ['B', 2],
      ]);
      layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);

      renderCanvas(
        canvas,
        baseCtx({
          metricInfos: [makeInfo('A', flatProcessor), makeInfo('B', flatProcessor)],
          layout,
          displayMode,
          category,
          categoryStyle: 'border',
        })
      );

      // Decoration is drawn as fillRect bands, never strokeRect, so it stays crisp at fractional cell sizes.
      expect(canvasEvents(canvas).filter((event) => event.type === 'strokeRect')).toHaveLength(0);
      const rects = fillRects(canvas);
      // 40px cell → 2px frame on the outer edge, then a 2px background moat inset by the frame.
      expect(rects).toContainEqual({ x: 0, y: 0, width: 40, height: 2 }); // frame top bar
      expect(rects).toContainEqual({ x: 2, y: 2, width: 36, height: 2 }); // moat top bar
      const styles = fillStyles(canvas);
      expect(styles).toContain('#ff0000'); // frame in the category color
      expect(styles).toContain(theme.colors.background.primary); // moat in the panel background
    }
  );

  it('snaps decoration bands to integer coordinates for fractional cell sizes', () => {
    const canvas = document.createElement('canvas');
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const layout = makeLayout([['A', 1]]);
    // A 0.5px-stepped layout can place a cell at half-integer coordinates (e.g. 2.5, size 39.5).
    Object.assign(layout.cells[0], { x: 2.5, y: 2.5, w: 39.5, h: 39.5 });
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout, category, categoryStyle: 'border' }));

    // Device snapping at dpr=1 rounds {2.5, 2.5, 39.5, 39.5} → {3, 3, 39, 39}; the frame top bar is integer.
    expect(fillRects(canvas)).toContainEqual({ x: 3, y: 3, width: 39, height: 2 });
    expect(canvasEvents(canvas).filter((event) => event.type === 'strokeRect')).toHaveLength(0);
  });

  it('draws a bottom strip at 15% height and skips uncategorized cells', () => {
    const canvas = document.createElement('canvas');
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const layout = makeLayout([
      ['A', 1],
      ['B', null],
    ]);
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    layout.cells.push({ x: 41, y: 0, w: 40, h: 40, cell: { ...layout.cells[0].cell, labelValues: undefined } });

    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout, category, categoryStyle: 'strip' }));

    // height = max(2, round(40 * 0.15)) = 6, full width, pinned to the cell's bottom edge (y = 40 - 6).
    expect(fillRects(canvas)).toContainEqual({ x: 0, y: 34, width: 40, height: 6 });
    expect(fillRects(canvas)).not.toContainEqual({ x: 41, y: 34, width: 40, height: 6 });
  });

  it('keeps the strip at least 2px tall for very short cells', () => {
    const canvas = document.createElement('canvas');
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const layout = makeLayout([['A', 1]]);
    layout.cells[0].h = 8; // round(8 * 0.15) = 1, so the floor of 2 applies
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout, category, categoryStyle: 'strip' }));
    expect(fillRects(canvas)).toContainEqual({ x: 0, y: 6, width: 40, height: 2 });
  });

  it('shrinks a 6px single cell outline so interior fill survives', () => {
    const canvas = document.createElement('canvas');
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const layout = makeLayout([['A', 1]]);
    Object.assign(layout.cells[0], { w: 6, h: 6 });
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    renderCanvas(canvas, baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout, category, categoryStyle: 'border' }));
    const rects = fillRects(canvas);
    // 6px cell: 1px frame + 1px moat per side (total 2px), leaving a 2px interior. Thin bars — not a 3px band
    // that would meet in the middle — are what let the underlying fill survive.
    expect(rects).toContainEqual({ x: 0, y: 0, width: 6, height: 1 }); // frame top bar (1px, not 3)
    expect(rects).toContainEqual({ x: 1, y: 1, width: 4, height: 1 }); // moat top bar (1px)
    expect(rects).toContainEqual({ x: 0, y: 1, width: 1, height: 4 }); // frame left bar spans interior only
  });

  // Build a split layout with `n` real metric zones so splitRects(n) actually tiles the cell.
  const splitLayout = (size: number, n: number) => {
    const values: Array<[string, number]> = Array.from({ length: n }, (_, i) => [String.fromCharCode(65 + i), 1]);
    const layout = makeLayout(values);
    Object.assign(layout.cells[0], { w: size, h: size });
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    return layout;
  };
  const category1 = (): CategoryModel => ({ label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) });

  const withDpr = (dpr: number, fn: () => void) => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
    }
  };
  const deviceAligned = (v: number, dpr: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6;

  // A drawn CSS-px fillRect converted to an integer device-px rect.
  const toDeviceRect = (r: { x: number; y: number; width: number; height: number }, dpr: number) => ({
    x: Math.round(r.x * dpr),
    y: Math.round(r.y * dpr),
    w: Math.round(r.width * dpr),
    h: Math.round(r.height * dpr),
  });
  type DevRect = { x: number; y: number; w: number; h: number };
  const covers = (d: DevRect, px: number, py: number) => px >= d.x && px < d.x + d.w && py >= d.y && py < d.y + d.h;
  // Does `fill` keep at least one device pixel that no rect drawn on top of it (`over`) paints over?
  const hasExposedPixel = (fill: DevRect, over: DevRect[]) => {
    for (let py = fill.y; py < fill.y + fill.h; py++) {
      for (let px = fill.x; px < fill.x + fill.w; px++) {
        if (!over.some((d) => covers(d, px, py))) {
          return true;
        }
      }
    }
    return false;
  };

  const cartesian = <A, B, C>(as: A[], bs: B[], cs: C[]): Array<[A, B, C]> =>
    as.flatMap((a) => bs.flatMap((b) => cs.map((c) => [a, b, c] as [A, B, C])));

  // The reviewer's real invariant: after ALL drawing (decoration + ring on top of the split fills), every
  // metric zone must still (a) be drawn at all and (b) expose at least one device pixel. We derive the
  // ground-truth zone fills from a decoration-free render, then treat the remaining rects of a
  // decorated+ringed render as the overpainting. DPR<1 (browser zoom-out) is included so the grout can't
  // erase narrow tiles, and every metric count 2..9 so partly-filled final rows are protected too.
  it.each(cartesian([6, 6.5], [0.75, 0.8, 1, 1.25, 1.5, 2], [2, 3, 4, 5, 6, 7, 8, 9]))(
    'keeps every split zone drawn and exposed on a %spx cell at dpr=%s with %s metrics',
    (size, dpr, metrics) => {
      withDpr(dpr, () => {
        const metricInfos = Array.from({ length: metrics }, (_, i) => makeInfo(String.fromCharCode(65 + i), flatProcessor));
        for (const categoryStyle of ['border', 'strip'] as const) {
          // Ground truth: split fills only (no category → no bands).
          const bare = document.createElement('canvas');
          renderCanvas(bare, baseCtx({ metricInfos, layout: splitLayout(size, metrics), displayMode: 'split' }));
          const zoneFills = fillRects(bare).map((r) => toDeviceRect(r, dpr));

          // Every metric must produce a visible tile: the grout must never zero out a zone.
          expect(zoneFills.length).toBe(metrics);

          // Decorated + ringed render draws the same fills first, then all the overpainting bands.
          const decorated = document.createElement('canvas');
          renderCanvas(
            decorated,
            baseCtx({
              metricInfos,
              layout: splitLayout(size, metrics),
              displayMode: 'split',
              category: category1(),
              categoryStyle,
              hoverCategoryValue: 'a',
            })
          );
          const all = fillRects(decorated).map((r) => toDeviceRect(r, dpr));
          const overpaint = all.slice(zoneFills.length); // everything drawn after the identical fill prefix

          for (const fill of zoneFills) {
            expect(hasExposedPixel(fill, overpaint)).toBe(true);
          }
        }
      });
    }
  );

  it.each([1, 1.25, 1.5, 2])('emits only device-aligned fillRects at dpr=%s', (dpr) => {
    withDpr(dpr, () => {
      const canvas = document.createElement('canvas');
      const layout = makeLayout([['A', 1]]);
      // A fractional cell that is not device-aligned at any of these DPRs.
      Object.assign(layout.cells[0], { x: 2.5, y: 2.5, w: 21.5, h: 21.5 });
      layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
      renderCanvas(
        canvas,
        baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout, category: category1(), categoryStyle: 'border', showValues: false })
      );
      const rects = fillRects(canvas);
      expect(rects.length).toBeGreaterThan(0);
      // Fill and every decoration band land on the device-pixel grid (coordinate*dpr is integral) → crisp.
      for (const r of rects) {
        expect(deviceAligned(r.x, dpr)).toBe(true);
        expect(deviceAligned(r.y, dpr)).toBe(true);
        expect(deviceAligned(r.width, dpr)).toBe(true);
        expect(deviceAligned(r.height, dpr)).toBe(true);
      }
    });
  });

  it.each(cartesian([0.75, 0.8, 1, 1.25, 1.5, 2], [2, 3, 4, 9], [40, 21.5]))(
    'emits only device-aligned split-tile fillRects at dpr=%s with %s metrics on a %spx cell',
    (dpr, metrics, size) => {
      withDpr(dpr, () => {
        const canvas = document.createElement('canvas');
        const metricInfos = Array.from({ length: metrics }, (_, i) => makeInfo(String.fromCharCode(65 + i), flatProcessor));
        const layout = splitLayout(size, metrics);
        // Offset the cell so its raw edges are not already device-aligned.
        Object.assign(layout.cells[0], { x: 2.5, y: 2.5 });
        renderCanvas(
          canvas,
          baseCtx({ metricInfos, layout, displayMode: 'split', category: category1(), categoryStyle: 'border', hoverCategoryValue: 'a' })
        );
        const rects = fillRects(canvas);
        expect(rects.length).toBeGreaterThan(0);
        // Every split tile boundary (and grout) as well as the decoration/ring bands sit on the device grid.
        for (const r of rects) {
          expect(deviceAligned(r.x, dpr)).toBe(true);
          expect(deviceAligned(r.y, dpr)).toBe(true);
          expect(deviceAligned(r.width, dpr)).toBe(true);
          expect(deviceAligned(r.height, dpr)).toBe(true);
        }
      });
    }
  );

  it('preserves an already device-aligned edge at dpr=2 instead of rounding CSS to an integer', () => {
    withDpr(2, () => {
      const canvas = document.createElement('canvas');
      const layout = makeLayout([['A', 1]]);
      // x=2.5 → device px 5, already aligned at dpr=2; CSS-integer rounding would wrongly move it to 3.
      Object.assign(layout.cells[0], { x: 2.5, y: 2.5, w: 20, h: 20 });
      layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
      renderCanvas(
        canvas,
        baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout, category: category1(), categoryStyle: 'border', showValues: false })
      );
      const rects = fillRects(canvas);
      // Frame (2 logical px → 4 device px → 2 css) starts exactly at the fill edge, no 1-device-px sliver.
      expect(rects).toContainEqual({ x: 2.5, y: 2.5, width: 20, height: 2 });
      expect(rects).toContainEqual({ x: 2.5, y: 2.5, width: 20, height: 20 }); // whole-cell fill shares the edge
    });
  });

  it('keeps the strip height stable regardless of a cell position sub-pixel offset', () => {
    // Same 16.5px logical height at two y-offsets. Deriving the strip from the *logical* height keeps it at a
    // constant 2px; deriving it from the position-dependent snapped height would jitter between 2px and 3px.
    const stripHeightAt = (oy: number): number => {
      const canvas = document.createElement('canvas');
      const layout = makeLayout([['A', 1]]);
      Object.assign(layout.cells[0], { x: 0, y: oy, w: 16.5, h: 16.5 });
      layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
      renderCanvas(
        canvas,
        baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout, category: category1(), categoryStyle: 'strip', showValues: false })
      );
      // The strip is the full-width band of small height; the whole-cell fill is the tall full-width rect.
      const strip = fillRects(canvas).find((r) => r.width >= 15 && r.height <= 5);
      return strip!.height;
    };
    expect(stripHeightAt(0)).toBe(2);
    expect(stripHeightAt(0.5)).toBe(2);
  });

  const twoCategoryLayout = () => {
    const layout = makeLayout([['A', 1]]);
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    layout.cells.push({
      x: 41,
      y: 0,
      w: 40,
      h: 40,
      cell: { ...layout.cells[0].cell, labelValues: new Map([['partition', ['b']]]) },
    });
    return layout;
  };
  const twoColorCategory: CategoryModel = {
    label: 'partition',
    values: ['a', 'b'],
    colorByValue: new Map([
      ['a', '#ff0000'],
      ['b', '#0000ff'],
    ]),
  };

  it('rings a hovered value with pixel-snapped bands and dims the rest', () => {
    const canvas = document.createElement('canvas');
    renderCanvas(
      canvas,
      baseCtx({
        metricInfos: [makeInfo('A', flatProcessor)],
        layout: twoCategoryLayout(),
        category: twoColorCategory,
        categoryStyle: 'strip',
        hoverCategoryValue: 'a',
      })
    );
    // Ring = 2px band on the outer edge (in the a color) + a 1px background separator inset by 2.
    expect(fillStyles(canvas)).toContain('#ff0000');
    const rects = fillRects(canvas);
    expect(rects).toContainEqual({ x: 0, y: 0, width: 40, height: 2 }); // ring top bar
    expect(rects).toContainEqual({ x: 2, y: 2, width: 36, height: 1 }); // separator top bar
    expect(canvasEvents(canvas).filter((event) => event.type === 'strokeRect')).toHaveLength(0);
    const alphas = canvasEvents(canvas)
      .filter((event) => event.type === 'globalAlpha')
      .map((event) => event.props.value);
    expect(alphas).toContain(0.22); // the non-matching (b) cell is dimmed
  });

  it('keeps interior fill when ringing a 6px cell (no separator, 2px ring only)', () => {
    const canvas = document.createElement('canvas');
    const layout = makeLayout([['A', 1]]);
    Object.assign(layout.cells[0], { w: 6, h: 6 });
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    renderCanvas(
      canvas,
      baseCtx({
        metricInfos: [makeInfo('A', flatProcessor)],
        layout,
        category: twoColorCategory,
        categoryStyle: 'strip',
        hoverCategoryValue: 'a',
      })
    );
    const rects = fillRects(canvas);
    // cap = 2 → 2px ring, 0px separator, leaving a 2px interior.
    expect(rects).toContainEqual({ x: 0, y: 0, width: 6, height: 2 }); // ring top bar
    expect(rects).not.toContainEqual({ x: 2, y: 2, width: 2, height: 1 }); // no separator drawn
  });

  it('draws no ring and no dimming when nothing is highlighted', () => {
    const canvas = document.createElement('canvas');
    renderCanvas(
      canvas,
      baseCtx({
        metricInfos: [makeInfo('A', flatProcessor)],
        layout: twoCategoryLayout(),
        category: twoColorCategory,
        categoryStyle: 'strip',
      })
    );
    const rects = fillRects(canvas);
    // With strip decoration only, no top-edge ring band is drawn on either cell.
    expect(rects).not.toContainEqual({ x: 0, y: 0, width: 40, height: 2 });
    expect(rects).not.toContainEqual({ x: 41, y: 0, width: 40, height: 2 });
    expect(
      canvasEvents(canvas)
        .filter((event) => event.type === 'globalAlpha')
        .map((event) => event.props.value)
    ).not.toContain(0.22);
  });

  it('lets a hover override the locked click selection', () => {
    const canvas = document.createElement('canvas');
    renderCanvas(
      canvas,
      baseCtx({
        metricInfos: [makeInfo('A', flatProcessor)],
        layout: twoCategoryLayout(),
        category: twoColorCategory,
        categoryStyle: 'strip',
        selectedCategoryValues: ['a'],
        hoverCategoryValue: 'b',
      })
    );
    // Hover 'b' wins: the b cell's ring is drawn in the b color; strip fill never uses the b color, so its
    // presence proves the ring followed the hover, not the locked selection.
    expect(fillStyles(canvas)).toContain('#0000ff');
  });

  it('rings a multi-value cell in the highlighted (secondary) value color, not its primary', () => {
    const canvas = document.createElement('canvas');
    const layout = makeLayout([['A', 1]]);
    // The cell carries both 'a' (primary, alphabetically first) and 'b'; hovering 'b' must ring in b's color.
    layout.cells[0].cell.labelValues = new Map([['partition', ['a', 'b']]]);
    renderCanvas(
      canvas,
      baseCtx({
        metricInfos: [makeInfo('A', flatProcessor)],
        layout,
        category: twoColorCategory,
        categoryStyle: 'strip',
        hoverCategoryValue: 'b',
      })
    );
    // Strip decoration paints the primary (a) color; the ring adds the b color only if it tracks the match.
    expect(fillStyles(canvas)).toContain('#0000ff');
  });

  it('draws the highlight ring regardless of decoration style', () => {
    const canvas = document.createElement('canvas');
    renderCanvas(
      canvas,
      baseCtx({
        metricInfos: [makeInfo('A', flatProcessor)],
        layout: twoCategoryLayout(),
        category: twoColorCategory,
        categoryStyle: 'border',
        hoverCategoryValue: 'a',
      })
    );
    // The ring's separator (1px, inset by the 2px ring) sits inside the outline's moat, proving the ring is
    // layered on top of the border decoration.
    expect(fillRects(canvas)).toContainEqual({ x: 2, y: 2, width: 36, height: 1 });
  });

  it('thickens the outline frame from 1px to 2px as cells grow', () => {
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const small = document.createElement('canvas');
    const smallLayout = makeLayout([['A', 1]]);
    Object.assign(smallLayout.cells[0], { w: 10, h: 10 });
    smallLayout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    renderCanvas(small, baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout: smallLayout, category, categoryStyle: 'border' }));
    expect(fillRects(small)).toContainEqual({ x: 0, y: 0, width: 10, height: 1 }); // 1px frame under 14px

    const large = document.createElement('canvas');
    const largeLayout = makeLayout([['A', 1]]);
    largeLayout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    renderCanvas(large, baseCtx({ metricInfos: [makeInfo('A', flatProcessor)], layout: largeLayout, category, categoryStyle: 'border' }));
    expect(fillRects(large)).toContainEqual({ x: 0, y: 0, width: 40, height: 2 }); // 2px frame at 40px
  });

  const fillTexts = (canvas: HTMLCanvasElement): Array<{ text: string; x: number; y: number }> =>
    (
      canvas.getContext('2d') as unknown as {
        __getEvents(): Array<{ type: string; props: { text: string; x: number; y: number } }>;
      }
    )
      .__getEvents()
      .filter((e) => e.type === 'fillText')
      .map((e) => e.props);

  it('shifts the value text up above the bottom strip instead of centering over it', () => {
    const canvas = document.createElement('canvas');
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const layout = makeLayout([['A', 1]]);
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    const spy = jest.fn((v: number): DisplayValue => ({ numeric: v, text: String(v), color: '#000000' }));
    renderCanvas(
      canvas,
      baseCtx({ metricInfos: [makeInfo('A', spy)], layout, category, categoryStyle: 'strip', showValues: true })
    );
    // boxH = 40 - stripHeight(6) = 34, so the centered baseline is 0 + 34/2 = 17, not the plain-center 20.
    expect(fillTexts(canvas).map((t) => t.y)).toContain(17);
  });

  it('skips the value when the outline safe-inset leaves too little room', () => {
    const canvas = document.createElement('canvas');
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#ff0000']]) };
    const layout = makeLayout([['A', 1]]);
    Object.assign(layout.cells[0], { w: 10, h: 10 });
    layout.cells[0].cell.labelValues = new Map([['partition', ['a']]]);
    const spy = jest.fn((v: number): DisplayValue => ({ numeric: v, text: String(v), color: '#000000' }));
    renderCanvas(
      canvas,
      baseCtx({ metricInfos: [makeInfo('A', spy)], layout, category, categoryStyle: 'border', showValues: true })
    );
    // Interior after 1px frame + 2px moat per side is 4px tall — below the text minimum — so no value is drawn.
    expect(fillTexts(canvas)).toHaveLength(0);
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
