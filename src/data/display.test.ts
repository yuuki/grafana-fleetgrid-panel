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
  it('builds one info per refId with auto min/max from that query only', () => {
    const infos = buildMetricInfos(
      [frame('A', 'power', [600, 1000]), frame('B', 'temp', [30, 90])],
      theme,
      'browser'
    );
    expect(infos.map((i) => i.refId)).toEqual(['A', 'B']);
    // Aのmin/maxはAのデータ範囲(600-1000)になる: 800は中間の色、Bの範囲とは独立
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
  });

  it('overrides inherited global state.range with the per-query range', () => {
    // applyFieldOverridesはパネル全体のグローバル範囲をstate.rangeに注入することがある
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
});

describe('chooseCellText', () => {
  // 幅 = 文字数 × fontPx × 0.6 の擬似メジャラ
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
