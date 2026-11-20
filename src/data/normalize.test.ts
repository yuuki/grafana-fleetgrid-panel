import { toDataFrame, FieldType } from '@grafana/data';
import { countFrameRows, isTableFrame, normalizeFrames } from './normalize';

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

describe('normalizeFrames row limit', () => {
  const table = (refId: string, zones: string[]) =>
    toDataFrame({
      refId,
      fields: [
        { name: 'zone', type: FieldType.string, values: zones },
        { name: 'Value', type: FieldType.number, values: zones.map((_, i) => i) },
      ],
    });
  const series = (zones: string[]) =>
    toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1000] },
        ...zones.map((zone) => ({ name: 'Value', type: FieldType.number, values: [1], labels: { zone } })),
      ],
    });
  const frames = [table('A', ['zone-a', 'zone-b', 'zone-c']), series(['zone-d', 'zone-e']), table('B', ['zone-f'])];

  it('reads every row without a limit', () => {
    expect(normalizeFrames(frames, 'lastNotNull')).toHaveLength(6);
    expect(countFrameRows(frames)).toBe(6);
  });

  it.each([0, 1, 3, 4, 5, 6, 7])('stops after %d rows, in frame and row order', (maxRows) => {
    const all = normalizeFrames(frames, 'lastNotNull');
    expect(normalizeFrames(frames, 'lastNotNull', maxRows)).toEqual(all.slice(0, maxRows));
  });

  it('counts no rows for a table frame without a numeric column', () => {
    const labelsOnly = toDataFrame({ fields: [{ name: 'zone', type: FieldType.string, values: ['zone-a'] }] });
    expect(countFrameRows([labelsOnly])).toBe(0);
    expect(normalizeFrames([labelsOnly], 'lastNotNull')).toEqual([]);
  });
});
