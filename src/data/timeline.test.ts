import { FieldType, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, LevelDef } from '../types';
import { buildHierarchy } from './hierarchy';
import { normalizeFrames } from './normalize';
import { attachCells, collectRefIds } from './values';
import { buildTimelineIndex, findLookbackIndex, timelineValueAt } from './timeline';

const levels: LevelDef[] = [
  { ...DEFAULT_LEVEL, label: 'zone' },
  { ...DEFAULT_LEVEL, label: 'host' },
];

function buildTree(frames: Array<ReturnType<typeof toDataFrame>>, agg: 'max' | 'mean' | 'min' | 'sum' = 'max') {
  const rows = normalizeFrames(frames, 'lastNotNull');
  const { root } = buildHierarchy(rows, levels);
  const refIds = collectRefIds(rows);
  attachCells(root, rows, levels, agg, refIds);
  return { root, refIds };
}

describe('buildTimelineIndex', () => {
  it('indexes range time-series frames into dense Float64Arrays per refId', () => {
    const frames = [
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000, 2000, 3000] },
          { name: 'Value', type: FieldType.number, values: [10, 20, 30], labels: { zone: 'zone-a', host: 'node-1' } },
          { name: 'Value', type: FieldType.number, values: [40, null, 60], labels: { zone: 'zone-a', host: 'node-2' } },
        ],
      }),
      toDataFrame({
        refId: 'B',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000, 3000] },
          { name: 'Value', type: FieldType.number, values: [5, 15], labels: { zone: 'zone-a', host: 'node-1' } },
        ],
      }),
    ];
    const { root, refIds } = buildTree(frames);
    const tl = buildTimelineIndex(frames, root, levels, 'max', refIds)!;

    expect(tl).toBeDefined();
    expect(Array.from(tl.timestamps)).toEqual([1000, 2000, 3000]);
    expect(tl.cellCount).toBe(2);
    expect(tl.downsampled).toBe(false);

    const c1 = tl.cellIndexByPath.get(JSON.stringify(['zone-a', 'node-1']))!;
    const c2 = tl.cellIndexByPath.get(JSON.stringify(['zone-a', 'node-2']))!;

    expect(timelineValueAt(tl, 'A', 0, c1)).toBe(10);
    expect(timelineValueAt(tl, 'A', 1, c1)).toBe(20);
    expect(timelineValueAt(tl, 'A', 2, c1)).toBe(30);
    expect(timelineValueAt(tl, 'A', 0, c2)).toBe(40);
    expect(timelineValueAt(tl, 'A', 1, c2)).toBeNull();
    expect(timelineValueAt(tl, 'A', 2, c2)).toBe(60);

    // Query B has no sample at t=2000 and no series for node-2
    expect(timelineValueAt(tl, 'B', 0, c1)).toBe(5);
    expect(timelineValueAt(tl, 'B', 1, c1)).toBeNull();
    expect(timelineValueAt(tl, 'B', 2, c1)).toBe(15);
    expect(timelineValueAt(tl, 'B', 0, c2)).toBeNull();

    expect(tl.rangeByRef.get('A')).toEqual({ min: 10, max: 60 });
    expect(tl.rangeByRef.get('B')).toEqual({ min: 5, max: 15 });
  });

  it.each([
    ['max', [30, 50]],
    ['min', [10, 50]],
    ['sum', [40, 50]],
    ['mean', [20, 50]],
  ] as const)('applies spatial aggregation (%s) across colliding series per timestamp', (agg, expected) => {
    const frames = [
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000, 2000] },
          {
            name: 'Value',
            type: FieldType.number,
            values: [10, 50],
            labels: { zone: 'zone-a', host: 'node-1', gpu: '0' },
          },
          {
            name: 'Value',
            type: FieldType.number,
            values: [30, Number.NaN],
            labels: { zone: 'zone-a', host: 'node-1', gpu: '1' },
          },
        ],
      }),
    ];
    const { root, refIds } = buildTree(frames, agg);
    const tl = buildTimelineIndex(frames, root, levels, agg, refIds)!;
    const c = tl.cellIndexByPath.get(JSON.stringify(['zone-a', 'node-1']))!;

    expect(timelineValueAt(tl, 'A', 0, c)).toBe(expected[0]);
    expect(timelineValueAt(tl, 'A', 1, c)).toBe(expected[1]);
  });

  it('returns undefined for table frames or 1-point instant frames', () => {
    const instant = [
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000] },
          { name: 'Value', type: FieldType.number, values: [42], labels: { zone: 'zone-a', host: 'node-1' } },
        ],
      }),
    ];
    const { root, refIds } = buildTree(instant);
    expect(buildTimelineIndex(instant, root, levels, 'max', refIds)).toBeUndefined();

    const table = [
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000, 2000] },
          { name: 'zone', type: FieldType.string, values: ['zone-a', 'zone-a'] },
          { name: 'host', type: FieldType.string, values: ['node-1', 'node-2'] },
          { name: 'Value', type: FieldType.number, values: [10, 20] },
        ],
      }),
    ];
    const tBuilt = buildTree(table);
    expect(buildTimelineIndex(table, tBuilt.root, levels, 'max', tBuilt.refIds)).toBeUndefined();
  });

  it('downsamples timestamps uniformly while preserving first and last when exceeding maxSlots', () => {
    const times = Array.from({ length: 10 }, (_, i) => (i + 1) * 1000);
    const vals = times.map((_, i) => i * 10);
    const frames = [
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: times },
          { name: 'Value', type: FieldType.number, values: vals, labels: { zone: 'zone-a', host: 'node-1' } },
          { name: 'Value', type: FieldType.number, values: vals, labels: { zone: 'zone-a', host: 'node-2' } },
        ],
      }),
    ];
    const { root, refIds } = buildTree(frames);
    // 2 cells, maxSlots = 8 -> maxSteps = 4
    const tl = buildTimelineIndex(frames, root, levels, 'max', refIds, 8)!;

    expect(tl.downsampled).toBe(true);
    expect(tl.rawTimestampCount).toBe(10);
    expect(tl.timestamps.length).toBe(4);
    expect(tl.timestamps[0]).toBe(1000);
    expect(tl.timestamps[3]).toBe(10000);
    expect(timelineValueAt(tl, 'A', 0, 0)).toBe(0);
    expect(timelineValueAt(tl, 'A', 3, 0)).toBe(90);
  });
});

describe('findLookbackIndex', () => {
  const ts = Float64Array.from([0, 15_000, 30_000, 60_000, 120_000]);

  it('returns the immediate previous step when lookbackSec <= 0', () => {
    expect(findLookbackIndex(ts, 0, 0)).toBe(-1);
    expect(findLookbackIndex(ts, 1, 0)).toBe(0);
    expect(findLookbackIndex(ts, 4, 0)).toBe(3);
    expect(findLookbackIndex(ts, 4, -10)).toBe(3);
  });

  it('binary-searches for the latest timestamp <= t - lookbackSec * 1000', () => {
    expect(findLookbackIndex(ts, 4, 60)).toBe(3); // 120s - 60s = 60s -> idx 3
    expect(findLookbackIndex(ts, 4, 90)).toBe(2); // 120s - 90s = 30s -> idx 2
    expect(findLookbackIndex(ts, 4, 100)).toBe(1); // 120s - 100s = 20s -> floor 15s -> idx 1
    expect(findLookbackIndex(ts, 4, 120)).toBe(0); // 120s - 120s = 0s -> idx 0
    expect(findLookbackIndex(ts, 4, 121)).toBe(-1); // before start of timeline
  });
});
