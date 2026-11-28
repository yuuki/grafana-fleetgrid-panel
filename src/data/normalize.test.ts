import { toDataFrame, FieldType } from '@grafana/data';
import { countFrameRows, forEachRowValue, isTableFrame, normalizeFrames } from './normalize';

describe('isTableFrame', () => {
  const strField = { name: 'zone', type: FieldType.string, values: ['zone-a'] };
  it('is table when a string column exists and no numeric field carries labels', () => {
    const frame = toDataFrame({ refId: 'A', fields: [strField, { name: 'Value', type: FieldType.number, values: [1] }] });
    expect(isTableFrame(frame)).toBe(true);
  });
  it('is NOT table when a numeric field carries labels, even alongside a string column', () => {
    // AND condition: even if hasStringColumn is true, it's treated as time_series if hasLabeledNumber is true (isolated verification)
    const frame = toDataFrame({
      refId: 'A',
      fields: [strField, { name: 'Value', type: FieldType.number, values: [1], labels: { host: 'node-a001' } }],
    });
    expect(isTableFrame(frame)).toBe(false);
  });
  it('is NOT table when there is no string column', () => {
    const frame = toDataFrame({ refId: 'A', fields: [{ name: 'Value', type: FieldType.number, values: [1] }] });
    expect(isTableFrame(frame)).toBe(false);
  });
});

describe('normalizeFrames', () => {
  it('extracts labels and last non-null value from time series frames', () => {
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000, 2000, 3000] },
        {
          name: 'Value',
          type: FieldType.number,
          values: [10, 20, null],
          labels: { zone: 'zone-a', 'host.name': 'node-a001', gpu: '0' },
        },
      ],
    });
    const rows = normalizeFrames([frame], 'lastNotNull');
    expect(rows).toEqual([
      {
        labels: { zone: 'zone-a', 'host.name': 'node-a001', gpu: '0' },
        value: 20,
        refId: 'A',
      },
    ]);
  });

  it('reads label columns and value column from table frames', () => {
    const frame = toDataFrame({
      refId: 'B',
      fields: [
        { name: 'zone', type: FieldType.string, values: ['zone-a', 'zone-b'] },
        { name: 'gpu', type: FieldType.string, values: ['0', '1'] },
        { name: 'Value', type: FieldType.number, values: [61, 55] },
      ],
    });
    const rows = normalizeFrames([frame], 'lastNotNull');
    expect(rows).toEqual([
      { labels: { zone: 'zone-a', gpu: '0' }, value: 61, refId: 'B' },
      { labels: { zone: 'zone-b', gpu: '1' }, value: 55, refId: 'B' },
    ]);
  });

  it('treats frames with string columns and unlabeled values as table even with a time column', () => {
    // Prometheus's instant+format=table has a Time column
    const frame = toDataFrame({
      refId: 'B',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000, 1000] },
        { name: 'zone', type: FieldType.string, values: ['zone-a', 'zone-b'] },
        { name: 'Value', type: FieldType.number, values: [61, 55] },
      ],
    });
    const rows = normalizeFrames([frame], 'lastNotNull');
    expect(rows).toHaveLength(2);
    expect(rows[0].labels).toEqual({ zone: 'zone-a' });
  });

  it('normalizes non-finite table values (NaN/Infinity) to null', () => {
    const frame = toDataFrame({
      refId: 'B',
      fields: [
        { name: 'zone', type: FieldType.string, values: ['zone-a', 'zone-b', 'zone-c'] },
        { name: 'Value', type: FieldType.number, values: [NaN, Infinity, 55] },
      ],
    });
    const rows = normalizeFrames([frame], 'lastNotNull');
    expect(rows.map((r) => r.value)).toEqual([null, null, 55]);
  });

  it.each([
    ['lastNotNull', [1, Infinity]],
    ['last', [1, -Infinity]],
    ['max', [1, Infinity]],
    ['min', [1, -Infinity]],
    ['sum', [Number.MAX_VALUE, Number.MAX_VALUE]],
  ])('normalizes a non-finite reduced series value (%s of %p) to null', (reduceCalc, values) => {
    // Found by normalize.property.test.ts: the time-series path used to let ±Infinity through,
    // while the table path (and the documented contract) treats non-finite values as missing.
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000, 2000] },
        { name: 'Value', type: FieldType.number, values, labels: { zone: 'zone-a' } },
      ],
    });
    expect(normalizeFrames([frame], reduceCalc)[0].value).toBeNull();
  });

  it('returns null value when a series is all null', () => {
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000] },
        { name: 'Value', type: FieldType.number, values: [null], labels: { zone: 'zone-a' } },
      ],
    });
    expect(normalizeFrames([frame], 'lastNotNull')[0].value).toBeNull();
  });
});

describe('countFrameRows and forEachRowValue', () => {
  const table = (refId: string, zones: string[], values = zones.map((_, i): number | null => i)) =>
    toDataFrame({
      refId,
      fields: [
        { name: 'zone', type: FieldType.string, values: zones },
        { name: 'Value', type: FieldType.number, values },
      ],
    });
  const series = (zones: string[]) =>
    toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000, 2000] },
        ...zones.map((zone, i) => ({ name: 'Value', type: FieldType.number, values: [i, i + 10], labels: { zone } })),
      ],
    });
  const frames = [
    table('A', ['zone-a', 'zone-b', 'zone-c'], [5, null, Infinity]),
    series(['zone-d', 'zone-e']),
    table('B', ['zone-f']),
  ];
  const visited = (reduceCalc: string) => {
    const out: Array<[number, number | null]> = [];
    frames.forEach((frame) => forEachRowValue(frame, reduceCalc, (row, value) => out.push([row, value])));
    return out;
  };

  it('counts the rows that normalizeFrames returns', () => {
    expect(normalizeFrames(frames, 'lastNotNull')).toHaveLength(6);
    expect(countFrameRows(frames)).toBe(6);
  });

  it('visits the value of every row in the order of normalizeFrames, without building rows', () => {
    // Table rows by row number; series by their position among the numeric fields. Missing and
    // non-finite values are null, as in the rows.
    expect(visited('lastNotNull')).toEqual([
      [0, 5],
      [1, null],
      [2, null],
      [0, 10],
      [1, 11],
      [0, 0],
    ]);
    expect(visited('lastNotNull').map(([, value]) => value)).toEqual(
      normalizeFrames(frames, 'lastNotNull').map((row) => row.value)
    );
    // A range series is reduced with the same calculation.
    expect(visited('mean').slice(3, 5)).toEqual([
      [0, 5],
      [1, 6],
    ]);
  });

  it('counts and visits no rows for a table frame without a numeric column', () => {
    const labelsOnly = toDataFrame({ fields: [{ name: 'zone', type: FieldType.string, values: ['zone-a'] }] });
    const visit = jest.fn();
    forEachRowValue(labelsOnly, 'lastNotNull', visit);
    expect(visit).not.toHaveBeenCalled();
    expect(countFrameRows([labelsOnly])).toBe(0);
    expect(normalizeFrames([labelsOnly], 'lastNotNull')).toEqual([]);
  });
});
