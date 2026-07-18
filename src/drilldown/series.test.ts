import { toDataFrame, FieldType } from '@grafana/data';
import { drilldownSeries, findSeriesFrames, getCellLinks } from './series';

const frame = (refId: string, labels: Record<string, string>, values: Array<number | null>) =>
  toDataFrame({
    refId,
    fields: [
      { name: 'Time', type: FieldType.time, values: values.map((_, i) => i * 1000) },
      { name: 'Value', type: FieldType.number, values, labels },
    ],
  });

// 1フレームに複数の数値フィールドを持つwide frame(数値フィールドごとに1系列)
const wideFrame = (refId: string, cols: Array<{ labels: Record<string, string>; values: Array<number | null> }>) =>
  toDataFrame({
    refId,
    fields: [
      { name: 'Time', type: FieldType.time, values: cols[0].values.map((_, i) => i * 1000) },
      ...cols.map((c, i) => ({ name: `V${i}`, type: FieldType.number, values: c.values, labels: c.labels })),
    ],
  });

describe('findSeriesFrames', () => {
  const frames = [
    frame('A', { zone: 'zone-a', gpu: '0' }, [1, 2]),
    frame('A', { zone: 'zone-a', gpu: '1' }, [3, 4]),
    frame('B', { zone: 'zone-a', gpu: '0' }, [5, 6]),
  ];
  it('matches refId and all cell labels', () => {
    const fs = findSeriesFrames(frames, 'A', { zone: 'zone-a', gpu: '1' });
    expect(fs).toHaveLength(1);
    expect(fs[0].fields[1].values[0]).toBe(3);
  });
  it('excludes single-point series', () => {
    expect(findSeriesFrames([frame('A', { zone: 'zone-a' }, [1])], 'A', { zone: 'zone-a' })).toHaveLength(0);
  });
  it('returns a wide frame once even when several of its fields match', () => {
    const wide = wideFrame('A', [
      { labels: { zone: 'zone-a', gpu: '0' }, values: [1, 2] },
      { labels: { zone: 'zone-a', gpu: '1' }, values: [3, 4] },
    ]);
    expect(findSeriesFrames([wide], 'A', { zone: 'zone-a' })).toHaveLength(1);
  });
});

describe('drilldownSeries', () => {
  it('aggregates multiple matching series per timestamp with the same spatial aggregation', () => {
    const frames = [
      frame('A', { zone: 'zone-a', gpu: '0' }, [10, 30]),
      frame('A', { zone: 'zone-a', gpu: '1' }, [20, 5]),
    ];
    const r = drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'max');
    expect(r.seriesCount).toBe(2);
    expect(r.aggregated).toBe(true);
    expect(r.frame!.fields[1].values).toEqual([20, 30]);
  });
  it('applies mean/min/sum per timestamp (not just max)', () => {
    const frames = [
      frame('A', { zone: 'zone-a', gpu: '0' }, [10, 30]),
      frame('A', { zone: 'zone-a', gpu: '1' }, [20, 6]),
    ];
    expect(drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'mean').frame!.fields[1].values).toEqual([15, 18]);
    expect(drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'min').frame!.fields[1].values).toEqual([10, 6]);
    expect(drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'sum').frame!.fields[1].values).toEqual([30, 36]);
  });
  it('excludes missing samples from aggregation and yields null when all missing', () => {
    // t0: 両系列, t1: 第2系列のみ, t2: 全欠損
    const frames = [
      frame('A', { zone: 'zone-a', gpu: '0' }, [10, null, null]),
      frame('A', { zone: 'zone-a', gpu: '1' }, [20, 4, null]),
    ];
    expect(drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'max').frame!.fields[1].values).toEqual([20, 4, null]);
    expect(drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'min').frame!.fields[1].values).toEqual([10, 4, null]);
    expect(drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'mean').frame!.fields[1].values).toEqual([15, 4, null]);
    expect(drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'sum').frame!.fields[1].values).toEqual([30, 4, null]);
  });
  it('treats each numeric field of a wide frame as its own series', () => {
    const wide = wideFrame('A', [
      { labels: { zone: 'zone-a', gpu: '0' }, values: [10, 30] },
      { labels: { zone: 'zone-a', gpu: '1' }, values: [20, 5] },
    ]);
    const r = drilldownSeries([wide], 'A', { zone: 'zone-a' }, 'max');
    expect(r.seriesCount).toBe(2);
    expect(r.aggregated).toBe(true);
    expect(r.frame!.fields[1].values).toEqual([20, 30]);
  });
  it('returns the single matching series as is', () => {
    const frames = [frame('A', { zone: 'zone-a', gpu: '0' }, [10, 30])];
    const r = drilldownSeries(frames, 'A', { zone: 'zone-a', gpu: '0' }, 'max');
    expect(r.seriesCount).toBe(1);
    expect(r.aggregated).toBe(false);
    expect(r.frame!.fields[1].values[1]).toBe(30);
  });
  it('falls back to the first series without aggregating when timestamps differ', () => {
    const a = frame('A', { zone: 'zone-a', gpu: '0' }, [10, 30]);
    const b = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [500, 1500] },
        { name: 'Value', type: FieldType.number, values: [20, 5], labels: { zone: 'zone-a', gpu: '1' } },
      ],
    });
    const r = drilldownSeries([a, b], 'A', { zone: 'zone-a' }, 'max');
    expect(r.seriesCount).toBe(2);
    expect(r.aggregated).toBe(false);
    expect(r.frame!.fields[1].values).toEqual([10, 30]); // 先頭系列そのまま
  });
});

describe('getCellLinks', () => {
  it('returns link models from field.getLinks with calculatedValue', () => {
    const f = frame('A', { zone: 'zone-a' }, [1, 2]);
    const getLinks = jest.fn(() => [
      { href: 'https://example.com/d/abc', target: '_blank', title: '', origin: {} as any },
    ]);
    f.fields[1].getLinks = getLinks as any;
    const calculated = { text: '2', numeric: 2 } as any;
    const links = getCellLinks([f], 'A', { zone: 'zone-a' }, calculated);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('https://example.com/d/abc');
    expect(getLinks).toHaveBeenCalledWith({ calculatedValue: calculated });
  });
  it('returns empty array when getLinks is absent', () => {
    expect(getCellLinks([frame('A', { zone: 'zone-a' }, [1, 2])], 'A', { zone: 'zone-a' })).toEqual([]);
  });
  it('gathers links from every matching numeric field of a wide frame', () => {
    const wide = wideFrame('A', [
      { labels: { zone: 'zone-a', gpu: '0' }, values: [1, 2] },
      { labels: { zone: 'zone-a', gpu: '1' }, values: [3, 4] },
    ]);
    wide.fields[1].getLinks = (() => [{ href: 'https://a', title: 'a', target: '_blank', origin: {} }]) as any;
    wide.fields[2].getLinks = (() => [{ href: 'https://b', title: 'b', target: '_blank', origin: {} }]) as any;
    const links = getCellLinks([wide], 'A', { zone: 'zone-a' });
    expect(links.map((l) => l.href)).toEqual(['https://a', 'https://b']);
  });
  it('resolves table rows by matching string columns', () => {
    const table = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'zone', type: FieldType.string, values: ['zone-a', 'zone-b'] },
        { name: 'Value', type: FieldType.number, values: [1, 2] },
      ],
    });
    const getLinks = jest.fn(() => [{ href: 'https://example.com/row', title: '', origin: {} as any }]);
    table.fields[1].getLinks = getLinks as any;
    const links = getCellLinks([table], 'A', { zone: 'zone-b' });
    expect(links).toHaveLength(1);
    expect(getLinks).toHaveBeenCalledWith({ valueRowIndex: 1 });
  });
});
