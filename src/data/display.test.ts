import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { buildMetricInfos, chooseCellText } from './display';

const theme = createTheme();

const frame = (refId: string, name: string, values: number[], config = {}) =>
  toDataFrame({
    refId,
    name,
    fields: [
      { name: 'Time', type: FieldType.time, values: values.map((_, i) => i * 1000) },
      { name: 'Value', type: FieldType.number, values, config, labels: { zone: 'zone-a' } },
    ],
  });

describe('buildMetricInfos', () => {
  const expectRange = (info: ReturnType<typeof buildMetricInfos>[number], min: number, max: number) => {
    expect(info).toMatchObject({ effectiveMin: min, effectiveMax: max });
    expect(info.field.config).toMatchObject({ min, max });
    expect(info.field.state?.range).toEqual({ min, max, delta: max - min });
  };

  it('builds one info per refId with auto min/max from that query only', () => {
    const infos = buildMetricInfos(
      [frame('A', 'power', [600, 1000]), frame('B', 'temp', [30, 90])],
      theme,
      'browser'
    );
    expect(infos.map((i) => i.refId)).toEqual(['A', 'B']);
    // A's min/max become A's data range (600-1000): 800 is a mid-range color, independent of B's range
    const a = infos[0].processor(800);
    const b = infos[1].processor(60);
    expect(a.color).toBeDefined();
    expect(b.color).toBeDefined();
    expect(infos[0].field.config.min).toBe(600);
    expect(infos[0].field.config.max).toBe(1000);
    expect(infos[1].field.config.min).toBe(30);
    expect(infos[1].field.config.max).toBe(90);
  });

  it('respects explicit min/max from field config', () => {
    const infos = buildMetricInfos([frame('A', 'power', [600, 1000], { min: 0, max: 2000 })], theme, 'browser');
    expect(infos[0].field.config.min).toBe(0);
    expect(infos[0].field.config.max).toBe(2000);
    expect(infos[0]).toMatchObject({
      effectiveMin: 0,
      effectiveMax: 2000,
      minConfigured: true,
      maxConfigured: true,
    });
  });

  it.each<[{ min?: number; max?: number }, boolean, boolean]>([
    [{ min: 0 }, true, false],
    [{ max: 2000 }, false, true],
    [{}, false, false],
  ])('tracks which range endpoints were explicitly configured', (config, minConfigured, maxConfigured) => {
    const [info] = buildMetricInfos([frame('A', 'power', [600, 1000], config)], theme, 'browser');
    expect(info).toMatchObject({ effectiveMin: config.min ?? 600, effectiveMax: config.max ?? 1000 });
    expect(info.minConfigured).toBe(minConfigured);
    expect(info.maxConfigured).toBe(maxConfigured);
  });

  it('overrides inherited global state.range with the per-query range', () => {
    // applyFieldOverrides may inject the panel-wide global range into state.range
    const f = frame('A', 'power', [600, 1000]);
    f.fields[1].state = { range: { min: 0, max: 2000, delta: 2000 } };
    const infos = buildMetricInfos([f], theme, 'browser');
    expect(infos[0].field.state?.range).toEqual({ min: 600, max: 1000, delta: 400 });
  });

  it('prefers cell-derived ranges when provided', () => {
    const infos = buildMetricInfos(
      [frame('A', 'power', [600, 1000])],
      theme,
      'browser',
      new Map([['A', { min: 700, max: 900 }]])
    );
    expect(infos[0].field.config.min).toBe(700);
    expect(infos[0].field.config.max).toBe(900);
  });

  it('ignores non-finite raw samples and expands a single finite auto value', () => {
    const [info] = buildMetricInfos([frame('A', 'power', [Infinity, 5, -Infinity, NaN])], theme, 'browser');
    expectRange(info, 5, 6);
  });

  it('uses 0–1 when no finite samples are available', () => {
    const [info] = buildMetricInfos([frame('A', 'power', [Infinity, -Infinity, NaN])], theme, 'browser');
    expectRange(info, 0, 1);
  });

  it('treats non-finite configured endpoints as automatic', () => {
    const [info] = buildMetricInfos(
      [frame('A', 'power', [10, 20], { min: Infinity, max: NaN })],
      theme,
      'browser'
    );
    expect(info).toMatchObject({ minConfigured: false, maxConfigured: false });
    expectRange(info, 10, 20);
  });

  it('expands equal explicitly configured endpoints', () => {
    const [info] = buildMetricInfos([frame('A', 'power', [10, 20], { min: 5, max: 5 })], theme, 'browser');
    expect(info).toMatchObject({ minConfigured: true, maxConfigured: true });
    expectRange(info, 5, 6);
  });

  it('keeps a fixed min above the automatic max and expands upward', () => {
    const [info] = buildMetricInfos([frame('A', 'power', [10, 20], { min: 100 })], theme, 'browser');
    expectRange(info, 100, 101);
  });

  it('keeps a fixed max below the automatic min and expands downward', () => {
    const [info] = buildMetricInfos([frame('A', 'power', [10, 20], { max: -100 })], theme, 'browser');
    expectRange(info, -101, -100);
  });

  it('sorts reversed explicitly configured endpoints into an ascending range', () => {
    const [info] = buildMetricInfos([frame('A', 'power', [10, 20], { min: 100, max: 0 })], theme, 'browser');
    expect(info).toMatchObject({ minConfigured: true, maxConfigured: true });
    expectRange(info, 0, 100);
  });

  it('expands a large single automatic value without falling back to 0–1', () => {
    const value = 1e16;
    const [info] = buildMetricInfos([frame('A', 'power', [value])], theme, 'browser');
    expect(info.effectiveMin).toBe(value);
    expect(info.effectiveMax).toBeGreaterThan(value);
    expectRange(info, info.effectiveMin, info.effectiveMax);
  });

  it('expands large equal fixed endpoints without falling back to 0–1', () => {
    const value = 1e16;
    const [info] = buildMetricInfos([frame('A', 'power', [1, 2], { min: value, max: value })], theme, 'browser');
    expect(info.effectiveMin).toBe(value);
    expect(info.effectiveMax).toBeGreaterThan(value);
    expectRange(info, info.effectiveMin, info.effectiveMax);
  });

  it('expands upward from a large fixed minimum above the data maximum', () => {
    const value = 1e16;
    const [info] = buildMetricInfos([frame('A', 'power', [1, 2], { min: value })], theme, 'browser');
    expect(info.effectiveMin).toBe(value);
    expect(info.effectiveMax).toBeGreaterThan(value);
    expectRange(info, info.effectiveMin, info.effectiveMax);
  });

  it('expands downward from a large fixed maximum below the data minimum', () => {
    const value = 1e16;
    const [info] = buildMetricInfos([frame('A', 'power', [2e16, 3e16], { max: value })], theme, 'browser');
    expect(info.effectiveMax).toBe(value);
    expect(info.effectiveMin).toBeLessThan(value);
    expectRange(info, info.effectiveMin, info.effectiveMax);
  });

  it.each([
    ['raw samples', frame('A', 'power', [-Number.MAX_VALUE, Number.MAX_VALUE]), undefined],
    [
      'field config',
      frame('A', 'power', [0, 1], { min: -Number.MAX_VALUE, max: Number.MAX_VALUE }),
      undefined,
    ],
    [
      'rangeByRef',
      frame('A', 'power', [0, 1]),
      new Map([['A', { min: -Number.MAX_VALUE, max: Number.MAX_VALUE }]]),
    ],
  ] as const)('keeps the final delta finite for an overflowing %s range', (_case, input, ranges) => {
    const [info] = buildMetricInfos([input], theme, 'browser', ranges as Map<string, { min: number; max: number }> | undefined);
    const delta = info.effectiveMax - info.effectiveMin;
    expect(info.effectiveMin).toBe(-Number.MAX_VALUE / 2);
    expect(info.effectiveMax).toBe(Number.MAX_VALUE / 2);
    expect(Number.isFinite(delta)).toBe(true);
    expect(delta).toBeGreaterThan(0);
    expectRange(info, info.effectiveMin, info.effectiveMax);
  });
});

describe('chooseCellText', () => {
  // A pseudo measurer: width = charCount × fontPx × 0.6
  const measure = (text: string, fontPx: number) => text.length * fontPx * 0.6;
  const display = { text: '503', suffix: ' W', numeric: 503 } as any;

  it('renders text with suffix when it fits', () => {
    const r = chooseCellText(display, 60, 20, measure);
    expect(r).toEqual({ text: '503 W', fontPx: 20 * 0.38 < 9 ? 9 : Math.min(15, 20 * 0.38) });
  });

  it('falls back to number only when suffix does not fit', () => {
    const r = chooseCellText(display, 24, 20, measure);
    expect(r?.text).toBe('503');
  });

  it('returns null when nothing fits', () => {
    expect(chooseCellText(display, 8, 20, measure)).toBeNull();
  });
});
