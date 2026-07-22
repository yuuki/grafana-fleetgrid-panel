import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { DEFAULT_LEVEL, RangeOverride } from '../types';
import { buildModel } from './model';

const theme = createTheme();
const options = {
  levels: [
    { ...DEFAULT_LEVEL, label: 'zone' },
    { ...DEFAULT_LEVEL, label: 'gpu', layout: 'grid' as const, gridColumns: 2 },
  ],
  displayMode: 'single' as const,
  showValues: true,
  missingColor: 'rgb(70,70,70)',
  spatialAggregation: 'max' as const,
  reduceCalc: 'lastNotNull',
};

const frame = (refId: string, zone: string, gpu: string, value: number | null) =>
  toDataFrame({
    refId,
    name: refId === 'A' ? 'power' : 'temp',
    fields: [
      { name: 'Time', type: FieldType.time, values: [1000] },
      { name: 'Value', type: FieldType.number, values: [value], labels: { zone, gpu } },
    ],
  });

// A fixture where the raw history (including past outliers) diverges from the post-reduce cell value
const seriesFrame = (refId: string, gpu: string, values: number[]) =>
  toDataFrame({
    refId,
    name: 'power',
    fields: [
      { name: 'Time', type: FieldType.time, values: values.map((_, i) => 1000 + i) },
      { name: 'Value', type: FieldType.number, values, labels: { zone: 'zone-a', gpu } },
    ],
  });

describe('buildModel', () => {
  it('produces tree, metric infos and refIds end to end', () => {
    const m = buildModel([frame('A', 'zone-a', '0', 503), frame('B', 'zone-a', '0', 61)], options, theme, 'browser');
    expect(m.warnings).toEqual([]);
    expect(m.refIds).toEqual(['A', 'B']);
    expect(m.metricInfos.map((i) => i.refId)).toEqual(['A', 'B']);
    const leaf = m.root.children[0].children[0];
    expect(leaf.cell!.values.get('A')).toBe(503);
  });

  it('orders metric infos by configured refId order, not by series appearance order', () => {
    // Even if data.series is in reverse order from targets (B first), the legend/split zones align in refId order (A,B)
    const m = buildModel([frame('B', 'zone-a', '0', 61), frame('A', 'zone-a', '0', 503)], options, theme, 'browser', [
      'A',
      'B',
    ]);
    expect(m.refIds).toEqual(['A', 'B']);
    expect(m.metricInfos.map((i) => i.refId)).toEqual(['A', 'B']);
  });

  it('propagates hierarchy warnings', () => {
    const m = buildModel(
      [frame('A', 'zone-a', '0', 1)],
      { ...options, levels: [{ ...DEFAULT_LEVEL, label: 'rack' }] },
      theme,
      'browser'
    );
    expect(m.warnings.length).toBeGreaterThan(0);
  });

  it('keeps refIds for configured queries that returned no series', () => {
    const m = buildModel([frame('A', 'zone-a', '0', 1)], options, theme, 'browser', ['A', 'B']);
    expect(m.refIds).toEqual(['A', 'B']);
    expect(m.root.children[0].children[0].cell!.values.get('B')).toBeNull();
  });

  it('builds the color range from spatially aggregated cell values, not individual series values', () => {
    // The zone-a cell has 2 series (10, 30) aggregated to 40 via sum. zone-b is 100.
    // If individual series values (10) were included in the range, min=10, but with only post-aggregation values, min=40.
    const opts = { ...options, levels: [{ ...DEFAULT_LEVEL, label: 'zone' }], spatialAggregation: 'sum' as const };
    const m = buildModel(
      [frame('A', 'zone-a', '0', 10), frame('A', 'zone-a', '1', 30), frame('A', 'zone-b', '0', 100)],
      opts,
      theme,
      'browser'
    );
    const infoA = m.metricInfos.find((i) => i.refId === 'A')!;
    expect(m.root.children.find((c) => c.key === 'zone-a')!.cell!.values.get('A')).toBe(40);
    expect(infoA.field.config.min).toBe(40); // Not the pre-aggregation 10
    expect(infoA.field.config.max).toBe(100);
  });

  it('derives the color range from reduced cell values, not raw history', () => {
    // gpu 0: current value 503 (raw peak 1000), gpu 1: current value 480 (raw trough 100)
    // If derived from the raw history, min=100/max=1000, but if derived from cell values, min=480/max=503
    const m = buildModel(
      [seriesFrame('A', '0', [1000, 503]), seriesFrame('A', '1', [100, 480])],
      options,
      theme,
      'browser'
    );
    const infoA = m.metricInfos.find((i) => i.refId === 'A')!;
    expect(infoA.field.config.min).toBe(480);
    expect(infoA.field.config.max).toBe(503);
  });

  it('resolves cell ranges from complete labels and reuses processors for identical effective ranges', () => {
    const opts = {
      ...options,
      levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
      rangeOverrides: [
        { refId: 'A', matchers: [{ label: 'zone', operator: 'exact' as const, value: 'zone-a' }], min: 0, max: 100 },
        { refId: 'A', matchers: [{ label: 'zone', operator: 'exact' as const, value: 'zone-b' }], min: 0, max: 200 },
        { refId: 'A', matchers: [{ label: 'zone', operator: 'exact' as const, value: 'zone-c' }], min: 0, max: 100 },
      ],
    };
    const m = buildModel(
      [frame('A', 'zone-a', '0', 50), frame('A', 'zone-b', '0', 50), frame('A', 'zone-c', '0', 50)],
      opts,
      theme,
      'browser'
    );
    const [a, b, c] = m.root.children.map((node) => node.cell!.ranges!.get('A')!);
    expect(a).toMatchObject({ effectiveMin: 0, effectiveMax: 100, source: 'override', matchedRuleIndex: 0 });
    expect(b).toMatchObject({ effectiveMin: 0, effectiveMax: 200, source: 'override', matchedRuleIndex: 1 });
    expect(a.processor).not.toBe(b.processor);
    expect(a.processor).toBe(c.processor);
    expect(m.rangeInfosByRef.get('A')).toHaveLength(2);
  });

  it('keeps equal endpoints with different fixed flags as distinct summary signatures', () => {
    const m = buildModel(
      [frame('A', 'zone-a', '0', 50), frame('A', 'zone-b', '0', 0)],
      {
        ...options,
        levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
        rangeOverrides: [
          { matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }], min: 0, max: 100 },
          { matchers: [{ label: 'zone', operator: 'exact', value: 'zone-b' }], max: 100 },
        ],
      },
      theme,
      'browser'
    );
    expect(m.rangeInfosByRef.get('A')).toHaveLength(2);
    expect(
      m.rangeInfosByRef.get('A')!.map(({ minConfigured, maxConfigured }) => [minConfigured, maxConfigured])
    ).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  it('fills a partial override from field config and then the automatic cell range', () => {
    const configured = frame('A', 'zone-a', '0', 50);
    configured.fields[1].config.min = 10;
    const opts = {
      ...options,
      levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
      rangeOverrides: [
        { refId: 'A', matchers: [{ label: 'zone', operator: 'exact' as const, value: 'zone-a' }], max: 100 },
        { refId: 'A', matchers: [{ label: 'zone', operator: 'exact' as const, value: 'zone-b' }], min: 0 },
      ],
    };
    const m = buildModel([configured, frame('A', 'zone-b', '0', 80)], opts, theme, 'browser');
    expect(m.root.children[0].cell!.ranges!.get('A')).toMatchObject({ effectiveMin: 10, effectiveMax: 100 });
    expect(m.root.children[1].cell!.ranges!.get('A')).toMatchObject({ effectiveMin: 0, effectiveMax: 80 });
  });

  it('fills a missing max from the raw automatic max instead of a normalized fixed-min range', () => {
    const fixedMin = frame('A', 'zone-a', '0', 10);
    fixedMin.fields[1].config.min = 100;
    const m = buildModel(
      [fixedMin, frame('A', 'zone-b', '0', 20)],
      {
        ...options,
        levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
        rangeOverrides: [{ refId: 'A', matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }], min: 0 }],
      },
      theme,
      'browser'
    );
    expect(m.metricInfos[0]).toMatchObject({ effectiveMin: 100, effectiveMax: 101 });
    expect(m.root.children[0].cell!.ranges!.get('A')).toMatchObject({ effectiveMin: 0, effectiveMax: 20 });
  });

  it('fills a missing min from the raw automatic min instead of a normalized fixed-max range', () => {
    const fixedMax = frame('A', 'zone-a', '0', 10);
    fixedMax.fields[1].config.max = -100;
    const m = buildModel(
      [fixedMax, frame('A', 'zone-b', '0', 20)],
      {
        ...options,
        levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
        rangeOverrides: [{ refId: 'A', matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }], max: 30 }],
      },
      theme,
      'browser'
    );
    expect(m.metricInfos[0]).toMatchObject({ effectiveMin: -101, effectiveMax: -100 });
    expect(m.root.children[0].cell!.ranges!.get('A')).toMatchObject({ effectiveMin: 10, effectiveMax: 30 });
  });

  it('resolves overrides from complete table row labels', () => {
    const table = toDataFrame({
      refId: 'A',
      name: 'bandwidth',
      fields: [
        { name: 'zone', type: FieldType.string, values: ['zone-a', 'zone-b'] },
        { name: 'bw_type', type: FieldType.string, values: ['NVLink RX', 'NVLink RX'] },
        { name: 'Value', type: FieldType.number, values: [50, 50] },
      ],
    });
    const m = buildModel(
      [table],
      {
        ...options,
        levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
        rangeOverrides: [
          {
            refId: 'A',
            matchers: [
              { label: 'zone', operator: 'exact', value: 'zone-a' },
              { label: 'bw_type', operator: 'regex', value: '^NVLink ' },
            ],
            min: 0,
            max: 100,
          },
        ],
      },
      theme,
      'browser'
    );
    expect(m.root.children[0].cell!.ranges!.get('A')).toMatchObject({ source: 'override', effectiveMax: 100 });
    expect(m.root.children[1].cell!.ranges).toBeUndefined();
    expect(m.rangeInfosByRef.get('A')).toHaveLength(2);
  });

  it('skips null values and lazily allocates cell ranges while building range summaries', () => {
    const m = buildModel(
      [frame('A', 'zone-a', '0', 50), frame('A', 'zone-b', '0', null)],
      {
        ...options,
        levels: [{ ...DEFAULT_LEVEL, label: 'zone' }],
        rangeOverrides: [
          { refId: 'A', matchers: [{ label: 'zone', operator: 'exact', value: 'zone-b' }], min: 0, max: 999 },
        ],
      },
      theme,
      'browser'
    );
    expect(m.root.children[0].cell!.ranges).toBeUndefined();
    expect(m.root.children[1].cell!.ranges).toBeUndefined();
    expect(m.rangeInfosByRef.get('A')).toHaveLength(1);
    expect(m.rangeInfosByRef.get('A')![0]).toMatchObject({ source: 'standard' });
  });

  it('falls back to the standard range and emits one refId-level warning for conflicting source labels', () => {
    const opts = {
      ...options,
      levels: [{ ...DEFAULT_LEVEL, label: 'gpu' }],
      rangeOverrides: [
        { refId: 'A', matchers: [{ label: 'zone', operator: 'exact' as const, value: 'zone-a' }], max: 100 },
        { refId: 'A', matchers: [{ label: 'zone', operator: 'exact' as const, value: 'zone-b' }], max: 200 },
      ],
    };
    const build = (inputs: Array<ReturnType<typeof frame>>) => buildModel(inputs, opts, theme, 'browser');
    const inputs = [frame('A', 'zone-a', '0', 50), frame('A', 'zone-b', '0', 50)];
    const forward = build(inputs);
    const reverse = build([...inputs].reverse());
    const standard = forward.metricInfos[0];
    for (const model of [forward, reverse]) {
      const range = model.root.children[0].cell!.ranges!.get('A')!;
      expect(range).toMatchObject({
        source: 'conflict',
        effectiveMin: standard.effectiveMin,
        effectiveMax: standard.effectiveMax,
      });
      expect(range.processor).toBe(model.metricInfos[0].processor);
      expect(
        model.warnings.filter((warning) => warning.includes('range override') && warning.includes('A'))
      ).toHaveLength(1);
    }
  });

  it.each([undefined, [], [null] as unknown as RangeOverride[]])(
    'skips provenance and cell ranges when rangeOverrides is %p',
    (rangeOverrides) => {
      const m = buildModel([frame('A', 'zone-a', '0', 50)], { ...options, rangeOverrides }, theme, 'browser');
      expect(m.root.children[0].children[0].cell!.sourceLabelSetsByRef).toBeUndefined();
      expect(m.root.children[0].children[0].cell!.ranges).toBeUndefined();
      expect(m.warnings).toEqual([]);
    }
  );
});
