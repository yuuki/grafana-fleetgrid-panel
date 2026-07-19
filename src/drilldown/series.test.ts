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

// A wide frame with multiple numeric fields in one frame (one series per numeric field)
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
    // t0: both series, t1: second series only, t2: all missing
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
    expect(r.frame!.fields[1].values).toEqual([10, 30]); // The first series unchanged
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
  it('collapses one Data Link applied to every aggregated series to a single link', () => {
    // A typical case where the same Data Link config is applied to each series, returning as many identical (href/title/target) links as there are series
    const frames = [
      frame('A', { zone: 'zone-a', gpu: '0' }, [1, 2]),
      frame('A', { zone: 'zone-a', gpu: '1' }, [3, 4]),
      frame('A', { zone: 'zone-a', gpu: '2' }, [5, 6]),
    ];
    const link = () => [{ href: 'https://example.com/d/dash', title: 'Dashboard', target: '_blank', origin: {} }];
    frames.forEach((f) => (f.fields[1].getLinks = link as any));
    const links = getCellLinks(frames, 'A', { zone: 'zone-a' });
    expect(links).toHaveLength(1); // Can be executed immediately as a single link
    expect(links[0].href).toBe('https://example.com/d/dash');
  });
  it('keeps links that share an href but differ in title', () => {
    const wide = wideFrame('A', [
      { labels: { zone: 'zone-a', gpu: '0' }, values: [1, 2] },
      { labels: { zone: 'zone-a', gpu: '1' }, values: [3, 4] },
    ]);
    wide.fields[1].getLinks = (() => [{ href: 'https://x', title: 'Logs', target: '_blank', origin: {} }]) as any;
    wide.fields[2].getLinks = (() => [{ href: 'https://x', title: 'Traces', target: '_blank', origin: {} }]) as any;
    const links = getCellLinks([wide], 'A', { zone: 'zone-a' });
    expect(links.map((l) => l.title)).toEqual(['Logs', 'Traces']);
  });
  it('keeps onClick links with the same origin but different callbacks', () => {
    // origin only indicates the source and doesn't guarantee identical behavior. Even with a matching origin, keep both if onClick differs
    const sharedOrigin = { name: 'field' } as any;
    const wide = wideFrame('A', [
      { labels: { zone: 'zone-a', gpu: '0' }, values: [1, 2] },
      { labels: { zone: 'zone-a', gpu: '1' }, values: [3, 4] },
    ]);
    wide.fields[1].getLinks = (() => [
      { href: 'https://x', title: 'D', target: '_self', origin: sharedOrigin, onClick: () => undefined },
    ]) as any;
    wide.fields[2].getLinks = (() => [
      { href: 'https://x', title: 'D', target: '_self', origin: sharedOrigin, onClick: () => undefined },
    ]) as any;
    expect(getCellLinks([wide], 'A', { zone: 'zone-a' })).toHaveLength(2);
  });
  it('collapses onClick links that share the same callback reference', () => {
    const shared = () => undefined;
    const frames = [
      frame('A', { zone: 'zone-a', gpu: '0' }, [1, 2]),
      frame('A', { zone: 'zone-a', gpu: '1' }, [3, 4]),
    ];
    frames[0].fields[1].getLinks = (() => [
      { href: 'https://x', title: 'D', target: '_self', origin: {}, onClick: shared },
    ]) as any;
    frames[1].fields[1].getLinks = (() => [
      { href: 'https://x', title: 'D', target: '_self', origin: {}, onClick: shared },
    ]) as any;
    expect(getCellLinks(frames, 'A', { zone: 'zone-a' })).toHaveLength(1);
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
  it('does not match a table row when a required label column is absent', () => {
    // Requesting gpu against a frame with no gpu column → must not falsely match (a missing column is a mismatch)
    const table = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'zone', type: FieldType.string, values: ['zone-a'] },
        { name: 'Value', type: FieldType.number, values: [1] },
      ],
    });
    table.fields[1].getLinks = (() => [{ href: 'https://x', title: '', origin: {} }]) as any;
    expect(getCellLinks([table], 'A', { zone: 'zone-a', gpu: '0' })).toEqual([]);
  });
  it('collects links from every matching table row, not just the first', () => {
    const table = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'zone', type: FieldType.string, values: ['zone-a', 'zone-a', 'zone-b'] },
        { name: 'Value', type: FieldType.number, values: [1, 2, 3] },
      ],
    });
    // A different href per row (not collapsed by dedupe). Verifies both zone-a rows are collected.
    table.fields[1].getLinks = ((opts: { valueRowIndex: number }) => [
      { href: `https://row/${opts.valueRowIndex}`, title: '', origin: {} },
    ]) as any;
    const links = getCellLinks([table], 'A', { zone: 'zone-a' });
    expect(links.map((l) => l.href)).toEqual(['https://row/0', 'https://row/1']);
  });
  it('collects Data Links from series matching any of multiple label sets', () => {
    // Collect Data Links from both sets in an extraction-key collision (e.g. node-a017 / node-b017 mapping to the same cell)
    const a = frame('A', { host: 'node-a017' }, [1, 2]);
    const b = frame('A', { host: 'node-b017' }, [3, 4]);
    a.fields[1].getLinks = (() => [{ href: 'https://a', title: 'A', target: '_blank', origin: {} }]) as any;
    b.fields[1].getLinks = (() => [{ href: 'https://b', title: 'B', target: '_blank', origin: {} }]) as any;
    const links = getCellLinks([a, b], 'A', [{ host: 'node-a017' }, { host: 'node-b017' }]);
    expect(links.map((l) => l.href).sort()).toEqual(['https://a', 'https://b']);
  });
  it('matches series across multiple colliding label sets (extraction-key collision)', () => {
    // labelSets search for when node-a017 and node-b017 collapse into the same cell
    const frames = [
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [0, 1000] },
          { name: 'Value', type: FieldType.number, values: [10, 30], labels: { host: 'node-a017' } },
        ],
      }),
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [0, 1000] },
          { name: 'Value', type: FieldType.number, values: [20, 5], labels: { host: 'node-b017' } },
        ],
      }),
    ];
    const r = drilldownSeries(frames, 'A', [{ host: 'node-a017' }, { host: 'node-b017' }], 'max');
    expect(r.seriesCount).toBe(2);
    expect(r.aggregated).toBe(true);
    expect(r.frame!.fields[1].values).toEqual([20, 30]);
  });
});
