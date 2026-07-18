import { toDataFrame, FieldType } from '@grafana/data';
import { DEFAULT_LEVEL } from '../types';
import { detectLabelKeys, previewLevel } from './LevelsEditor';

const tsFrame = toDataFrame({
  refId: 'A',
  fields: [
    { name: 'Time', type: FieldType.time, values: [1] },
    { name: 'Value', type: FieldType.number, values: [1], labels: { zone: 'zone-a', gpu: '0' } },
  ],
});
const tableFrame = toDataFrame({
  refId: 'B',
  fields: [
    { name: 'host', type: FieldType.string, values: ['node-a001', 'node-a002', 'node-a001'] },
    { name: 'Value', type: FieldType.number, values: [1, 2, 3] },
  ],
});

describe('detectLabelKeys', () => {
  it('collects label keys from series labels and table string columns', () => {
    expect(detectLabelKeys([tsFrame, tableFrame]).sort()).toEqual(['gpu', 'host', 'zone']);
  });
});

describe('previewLevel', () => {
  it('counts distinct extracted keys with samples in natural order', () => {
    const p = previewLevel([tableFrame], { ...DEFAULT_LEVEL, label: 'host', extract: 'trailingNumber' });
    expect(p.count).toBe(2);
    expect(p.samples).toEqual(['001', '002']);
  });
  it('returns zero when nothing matches', () => {
    const p = previewLevel([tableFrame], {
      ...DEFAULT_LEVEL,
      label: 'host',
      extract: 'regex',
      regex: 'nomatch-(\\d+)',
    });
    expect(p.count).toBe(0);
  });
});
