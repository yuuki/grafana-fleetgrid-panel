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

// 生履歴(過去の外れ値を含む)と reduce 後のセル値がずれるフィクスチャ
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
    // data.series が targets 順と逆(B が先)でも、凡例/分割区画は refId 順(A,B)に整列する
    const m = buildModel(
      [frame('B', 'zone-a', '0', 61), frame('A', 'zone-a', '0', 503)],
      options,
      theme,
      'browser',
      ['A', 'B']
    );
    expect(m.refIds).toEqual(['A', 'B']);
    expect(m.metricInfos.map((i) => i.refId)).toEqual(['A', 'B']);
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

  it('builds the color range from spatially aggregated cell values, not individual series values', () => {
    // zone-a セルに 2 系列(10, 30)が sum で 40 に集約される。zone-b は 100。
    // 個々の系列値(10)が range に入るなら min=10 だが、集約後の値だけなら min=40。
    const opts = { ...options, levels: [{ ...DEFAULT_LEVEL, label: 'zone' }], spatialAggregation: 'sum' as const };
    const m = buildModel(
      [frame('A', 'zone-a', '0', 10), frame('A', 'zone-a', '1', 30), frame('A', 'zone-b', '0', 100)],
      opts,
      theme,
      'browser'
    );
    const infoA = m.metricInfos.find((i) => i.refId === 'A')!;
    expect(m.root.children.find((c) => c.key === 'zone-a')!.cell!.values.get('A')).toBe(40);
    expect(infoA.field.config.min).toBe(40); // 集約前の 10 ではない
    expect(infoA.field.config.max).toBe(100);
  });

  it('derives the color range from reduced cell values, not raw history', () => {
    // gpu 0: 現在値 503(生の peak 1000)、gpu 1: 現在値 480(生の trough 100)
    // 生履歴由来なら min=100/max=1000 になるが、セル値由来なら min=480/max=503
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
});
