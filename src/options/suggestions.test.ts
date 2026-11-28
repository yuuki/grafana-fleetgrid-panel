import { FieldType, toDataFrame } from '@grafana/data';
import { cellFrames, collectLabelNames } from './suggestions';

const cells = toDataFrame({
  refId: 'A',
  fields: [
    { name: 'host', type: FieldType.string, values: ['node-a1'] },
    { name: 'power', type: FieldType.number, values: [1] },
  ],
});
const edges = toDataFrame({
  refId: 'E',
  fields: [
    { name: 'src_host', type: FieldType.string, values: ['node-a1'] },
    { name: 'dst_host', type: FieldType.string, values: ['node-a2'] },
    { name: 'loss', type: FieldType.number, values: [1] },
  ],
});

describe('cellFrames', () => {
  it('returns the frames themselves while no edge query is named', () => {
    const frames = [cells, edges];
    expect(cellFrames(frames, {})).toBe(frames);
    expect(cellFrames(frames, { flowRefId: ' ' })).toBe(frames);
    expect(cellFrames(frames, undefined)).toBe(frames);
    expect(cellFrames(undefined, { flowRefId: 'E' })).toEqual([]);
  });

  it('leaves out the frames of the edge query, named with or without spaces around the refId', () => {
    expect(cellFrames([cells, edges], { flowRefId: 'E' })).toEqual([cells]);
    expect(cellFrames([cells, edges], { flowRefId: ' E ' })).toEqual([cells]);
    // A frame without a refId counts as query A, as everywhere else.
    const unnamed = toDataFrame({ fields: [{ name: 'loss', type: FieldType.number, values: [1] }] });
    expect(cellFrames([unnamed, edges], { flowRefId: 'A' })).toEqual([edges]);
  });
});

describe('collectLabelNames', () => {
  it('lists the string columns of a table and the labels of series, sorted and without duplicates', () => {
    const series = toDataFrame({
      refId: 'E',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1] },
        { name: 'Value', type: FieldType.number, values: [1], labels: { src_host: 'node-a1', job: 'ring-a' } },
      ],
    });
    expect(collectLabelNames([edges])).toEqual(['dst_host', 'src_host']);
    expect(collectLabelNames([series, edges])).toEqual(['dst_host', 'job', 'src_host']);
    expect(collectLabelNames([])).toEqual([]);
  });

  it('reads no value, whatever the number of rows', () => {
    // A field whose values throw when they are read: only the fields themselves are looked at.
    const values = new Proxy(['node-a1'], {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          throw new Error('a value was read');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const frame = { ...edges, fields: edges.fields.map((field) => ({ ...field, values })) };
    expect(collectLabelNames([frame])).toEqual(['dst_host', 'src_host']);
  });
});
