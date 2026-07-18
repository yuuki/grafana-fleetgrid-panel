import { createTheme, toDataFrame, FieldType } from '@grafana/data';
import { DEFAULT_LEVEL } from '../types';
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

const frame = (refId: string, zone: string, gpu: string, value: number) =>
  toDataFrame({
    refId,
    name: refId === 'A' ? 'power' : 'temp',
    fields: [
      { name: 'Time', type: FieldType.time, values: [1000] },
      { name: 'Value', type: FieldType.number, values: [value], labels: { zone, gpu } },
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

  it('propagates hierarchy warnings', () => {
    const m = buildModel([frame('A', 'zone-a', '0', 1)], { ...options, levels: [{ ...DEFAULT_LEVEL, label: 'rack' }] }, theme, 'browser');
    expect(m.warnings.length).toBeGreaterThan(0);
  });

  it('keeps refIds for configured queries that returned no series', () => {
    const m = buildModel([frame('A', 'zone-a', '0', 1)], options, theme, 'browser', ['A', 'B']);
    expect(m.refIds).toEqual(['A', 'B']);
    expect(m.root.children[0].children[0].cell!.values.get('B')).toBeNull();
  });
});
