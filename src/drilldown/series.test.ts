import { toDataFrame, FieldType } from '@grafana/data';
import { drilldownSeries, findSeriesFrames, getCellLinks } from './series';

const frame = (refId: string, labels: Record<string, string>, values: number[]) =>
  toDataFrame({
    refId,
    fields: [
      { name: 'Time', type: FieldType.time, values: values.map((_, i) => i * 1000) },
      { name: 'Value', type: FieldType.number, values, labels },
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
});

describe('drilldownSeries', () => {
  it('aggregates multiple matching series per timestamp with the same spatial aggregation', () => {
    const frames = [
      frame('A', { zone: 'zone-a', gpu: '0' }, [10, 30]),
      frame('A', { zone: 'zone-a', gpu: '1' }, [20, 5]),
    ];
    const r = drilldownSeries(frames, 'A', { zone: 'zone-a' }, 'max');
    expect(r.seriesCount).toBe(2);
    expect(r.frame!.fields[1].values).toEqual([20, 30]);
  });
  it('returns the single matching series as is', () => {
    const frames = [frame('A', { zone: 'zone-a', gpu: '0' }, [10, 30])];
    const r = drilldownSeries(frames, 'A', { zone: 'zone-a', gpu: '0' }, 'max');
    expect(r.seriesCount).toBe(1);
    expect(r.frame!.fields[1].values[1]).toBe(30);
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
