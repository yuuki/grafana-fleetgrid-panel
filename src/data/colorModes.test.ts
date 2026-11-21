import { createTheme, FieldType, toDataFrame } from '@grafana/data';
import { DEFAULT_LEVEL, LevelDef } from '../types';
import { buildHierarchy } from './hierarchy';
import { normalizeFrames } from './normalize';
import { attachCells, collectRefIds } from './values';
import { buildMetricInfos } from './display';
import { buildTimelineIndex, collectLeafCellIndices } from './timeline';
import {
  buildDeltaProcessor,
  buildDeltaRangeInfos,
  buildFrameSlices,
  buildSiblingGroups,
  buildTimelineRangeInfos,
  buildZScoreProcessor,
  computeSpatialZScores,
  computeTemporalDeltaGlobalMaxAbs,
  computeTemporalDeltaSlice,
  divergingColor,
  extractReducedValueArrays,
  formatLookbackLabel,
  resolveZScoreGroupDepth,
  valueToDivergingRatio,
} from './colorModes';

const darkTheme = createTheme({ colors: { mode: 'dark' } });
const lightTheme = createTheme({ colors: { mode: 'light' } });

describe('divergingColor & valueToDivergingRatio', () => {
  it('maps -1, 0, +1 to cool blue, theme-aware neutral, and warm red', () => {
    expect(divergingColor(-1, true)).toBe('rgb(33, 102, 172)');
    expect(divergingColor(0, true)).toBe('rgb(58, 63, 75)');
    expect(divergingColor(0, false)).toBe('rgb(232, 236, 239)');
    expect(divergingColor(1, true)).toBe('rgb(178, 24, 43)');
    // Clamping outside [-1, 1]
    expect(divergingColor(-5, true)).toBe(divergingColor(-1, true));
    expect(divergingColor(5, true)).toBe(divergingColor(1, true));
  });

  it('pins zero to 0 even with asymmetric min/max straddling zero', () => {
    expect(valueToDivergingRatio(0, -10, 100)).toBe(0);
    expect(valueToDivergingRatio(-5, -10, 100)).toBe(-0.5);
    expect(valueToDivergingRatio(50, -10, 100)).toBe(0.5);
    expect(valueToDivergingRatio(150, -10, 100)).toBe(1);
    expect(valueToDivergingRatio(-20, -10, 100)).toBe(-1);
  });

  it('formats lookback labels clearly', () => {
    expect(formatLookbackLabel(0)).toBe('1 step');
    expect(formatLookbackLabel(30)).toBe('30s');
    expect(formatLookbackLabel(300)).toBe('5m');
    expect(formatLookbackLabel(3600)).toBe('1h');
    expect(formatLookbackLabel(90)).toBe('90s');
  });
});

describe('delta and z-score processors', () => {
  it('buildDeltaProcessor preserves unit formatting, adds + sign, and uses diverging colors', () => {
    const base = (v: unknown) => ({ numeric: Number(v), text: `${Number(v).toFixed(1)}`, suffix: ' W' });
    const proc = buildDeltaProcessor(base, -50, 50, darkTheme);

    const pos = proc(25);
    expect(pos.text).toBe('+25.0');
    expect(pos.suffix).toBe(' W');
    expect(pos.color).toBe(divergingColor(0.5, true));

    const zero = proc(0);
    expect(zero.text).toBe('0.0');
    expect(zero.color).toBe(divergingColor(0, true));

    const neg = proc(-50);
    expect(neg.text).toBe('-50.0');
    expect(neg.color).toBe(divergingColor(-1, true));
  });

  it('buildZScoreProcessor formats signed sigma strings and maps diverging colors', () => {
    const proc = buildZScoreProcessor(-3, 3, 1, lightTheme);
    expect(proc(2.5)).toMatchObject({ text: '+2.5', suffix: 'σ', color: divergingColor(2.5 / 3, false) });
    expect(proc(-1.5)).toMatchObject({ text: '-1.5', suffix: 'σ', color: divergingColor(-0.5, false) });
    expect(proc(0)).toMatchObject({ text: '0.0', suffix: 'σ', color: divergingColor(0, false) });
  });
});

describe('spatial Z-score grouping and calculation', () => {
  const levels: LevelDef[] = [
    { ...DEFAULT_LEVEL, label: 'zone' },
    { ...DEFAULT_LEVEL, label: 'host' },
    { ...DEFAULT_LEVEL, label: 'gpu' },
  ];

  it('resolves zScoreGroupDepth across parent, fleet, and explicit level indices', () => {
    expect(resolveZScoreGroupDepth(3, undefined)).toBe(2); // parent of leaf (host)
    expect(resolveZScoreGroupDepth(3, -1)).toBe(2); // parent of leaf (host)
    expect(resolveZScoreGroupDepth(3, -2)).toBe(0); // entire fleet
    expect(resolveZScoreGroupDepth(3, 0)).toBe(1); // within zone
    expect(resolveZScoreGroupDepth(3, 1)).toBe(2); // within host
    expect(resolveZScoreGroupDepth(3, 5)).toBe(2); // clamped below leaf depth
    expect(resolveZScoreGroupDepth(1, -1)).toBe(0); // 1-level falls back to fleet
  });

  it('computes exact mean/stddev Z-scores per sibling group and treats <2 siblings as NaN', () => {
    const frames = [
      toDataFrame({
        refId: 'A',
        fields: [
          { name: 'Time', type: FieldType.time, values: [1000] },
          { name: 'Value', type: FieldType.number, values: [10], labels: { zone: 'z1', host: 'h1', gpu: '0' } },
          { name: 'Value', type: FieldType.number, values: [20], labels: { zone: 'z1', host: 'h1', gpu: '1' } },
          { name: 'Value', type: FieldType.number, values: [30], labels: { zone: 'z1', host: 'h1', gpu: '2' } },
          // Singleton host h2 -> <2 siblings -> must be NaN, not 0
          { name: 'Value', type: FieldType.number, values: [99], labels: { zone: 'z1', host: 'h2', gpu: '0' } },
          // Constant host h3 -> stddev 0 -> must be 0
          { name: 'Value', type: FieldType.number, values: [50], labels: { zone: 'z1', host: 'h3', gpu: '0' } },
          { name: 'Value', type: FieldType.number, values: [50], labels: { zone: 'z1', host: 'h3', gpu: '1' } },
        ],
      }),
    ];
    const rows = normalizeFrames(frames, 'lastNotNull');
    const { root } = buildHierarchy(rows, levels);
    const refIds = collectRefIds(rows);
    attachCells(root, rows, levels, 'max', refIds);
    const cellIdx = collectLeafCellIndices(root, levels.length);
    const raw = extractReducedValueArrays(root, levels.length, cellIdx, refIds).get('A')!;
    const groups = buildSiblingGroups(root, levels.length, cellIdx, -1);
    const res = computeSpatialZScores(raw, groups, 'mean');

    const i0 = cellIdx.get(JSON.stringify(['z1', 'h1', '0']))!;
    const i1 = cellIdx.get(JSON.stringify(['z1', 'h1', '1']))!;
    const i2 = cellIdx.get(JSON.stringify(['z1', 'h1', '2']))!;
    const iSingle = cellIdx.get(JSON.stringify(['z1', 'h2', '0']))!;
    const iConst0 = cellIdx.get(JSON.stringify(['z1', 'h3', '0']))!;

    // Values [10, 20, 30] -> mean 20, pop std sqrt(200/3)
    const std = Math.sqrt(200 / 3);
    expect(res.values[i0]).toBeCloseTo(-10 / std, 6);
    expect(res.values[i1]).toBeCloseTo(0, 6);
    expect(res.values[i2]).toBeCloseTo(10 / std, 6);
    expect(res.statsByCell[i2]).toMatchObject({ center: 20, groupSize: 3, groupPath: ['z1', 'h1'] });
    expect(Number.isNaN(res.values[iSingle])).toBe(true);
    expect(res.values[iConst0]).toBe(0);
  });

  it('computes robust median/MAD Z-scores and falls back to scaled meanAD when MAD is 0', () => {
    // [10, 10, 10, 100]: median=10, MAD=0, meanAD=22.5 -> outlier 100 still gets strong positive Z-score
    const raw = Float64Array.from([10, 10, 10, 100]);
    const groups = [{ path: ['z1'], cellIndices: [0, 1, 2, 3] }];
    const res = computeSpatialZScores(raw, groups, 'median');

    expect(res.values[0]).toBe(0);
    expect(res.values[3]).toBeGreaterThan(3);
    expect(res.statsByCell[3]?.center).toBe(10);
  });
});

describe('temporal delta and buildFrameSlices', () => {
  const levels: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'zone' }];
  const frames = [
    toDataFrame({
      refId: 'A',
      name: 'temp',
      fields: [
        { name: 'Time', type: FieldType.time, values: [0, 60_000, 120_000] },
        {
          name: 'Value',
          type: FieldType.number,
          values: [40, 45, 65],
          labels: { zone: 'zone-a' },
          config: { unit: 'celsius', decimals: 1 },
        },
        {
          name: 'Value',
          type: FieldType.number,
          values: [50, 48, 40],
          labels: { zone: 'zone-b' },
          config: { unit: 'celsius', decimals: 1 },
        },
      ],
    }),
  ];

  const setup = () => {
    const rows = normalizeFrames(frames, 'lastNotNull');
    const { root } = buildHierarchy(rows, levels);
    const refIds = collectRefIds(rows);
    attachCells(root, rows, levels, 'max', refIds);
    const metricInfos = buildMetricInfos(frames, darkTheme, 'utc');
    const timeline = buildTimelineIndex(frames, root, levels, 'max', refIds)!;
    return { root, refIds, metricInfos, timeline };
  };

  it('computes temporal delta v(t) - v(t - Δt) and global maxAbs across the timeline', () => {
    const { timeline } = setup();
    const slice = computeTemporalDeltaSlice(timeline, 'A', 2, 60);
    expect(slice.prevIndex).toBe(1);
    expect(Array.from(slice.values)).toEqual([20, -8]);
    expect(Array.from(slice.rawValues)).toEqual([65, 40]);
    expect(Array.from(slice.baselineValues)).toEqual([45, 48]);
    expect(computeTemporalDeltaGlobalMaxAbs(timeline, 'A', 60)).toBe(20);
  });

  it('returns undefined in default value mode without scrubbing, and evaluates value/delta/zscore slices', () => {
    const { root, refIds, metricInfos, timeline } = setup();

    // Default mode + no scrub -> undefined (legacy path untouched)
    expect(
      buildFrameSlices({
        colorMode: 'value',
        metricInfos,
        timeline,
        scrubIndex: null,
        deltaLookbackSec: 0,
        zScoreMethod: 'mean',
        zScoreLimit: 3,
        theme: darkTheme,
        timeZone: 'utc',
      })
    ).toBeUndefined();

    // Scrubbing in value mode -> zero-copy subarray
    const valueSlices = buildFrameSlices({
      colorMode: 'value',
      metricInfos,
      timeline,
      scrubIndex: 1,
      deltaLookbackSec: 0,
      timelineRangeInfosByRef: buildTimelineRangeInfos(metricInfos, timeline, darkTheme, 'utc'),
      zScoreMethod: 'mean',
      zScoreLimit: 3,
      theme: darkTheme,
      timeZone: 'utc',
    })!;
    expect(Array.from(valueSlices.get('A')!.values)).toEqual([45, 48]);
    expect(valueSlices.get('A')!.overridesCellRanges).toBe(false);

    // Delta mode (at latest timestamp when scrubIndex is null)
    const deltaSlices = buildFrameSlices({
      colorMode: 'delta',
      metricInfos,
      timeline,
      scrubIndex: null,
      deltaLookbackSec: 60,
      deltaRangeInfosByRef: buildDeltaRangeInfos(metricInfos, timeline, 60, darkTheme),
      zScoreMethod: 'mean',
      zScoreLimit: 3,
      theme: darkTheme,
      timeZone: 'utc',
    })!;
    const dSlice = deltaSlices.get('A')!;
    expect(Array.from(dSlice.values)).toEqual([20, -8]);
    expect(dSlice.modeLabel).toBe('Δ 1m');
    expect(dSlice.overridesCellRanges).toBe(true);
    expect(dSlice.rangeInfo.effectiveMin).toBe(-20);
    expect(dSlice.rangeInfo.effectiveMax).toBe(20);

    // Z-score mode on reduced data
    const cellIdx = timeline.cellIndexByPath;
    const zSlices = buildFrameSlices({
      colorMode: 'zscore',
      metricInfos,
      timeline,
      scrubIndex: null,
      deltaLookbackSec: 0,
      zScoreMethod: 'mean',
      zScoreLimit: 3,
      siblingGroups: buildSiblingGroups(root, levels.length, cellIdx, -1),
      reducedArraysByRef: extractReducedValueArrays(root, levels.length, cellIdx, refIds),
      theme: darkTheme,
      timeZone: 'utc',
    })!;
    const zSlice = zSlices.get('A')!;
    expect(zSlice.modeLabel).toBe('Z-score (mean)');
    expect(zSlice.values[0]).toBeCloseTo(1, 6); // 65 vs 40 -> +1σ, -1σ
    expect(zSlice.values[1]).toBeCloseTo(-1, 6);
  });

  it('ignores raw Field Config min/max (e.g. 0..100) in delta mode so 0 stays neutral and negatives are blue', () => {
    const constrainedFrames = [
      toDataFrame({
        refId: 'A',
        name: 'util',
        fields: [
          { name: 'Time', type: FieldType.time, values: [0, 60_000] },
          {
            name: 'Value',
            type: FieldType.number,
            values: [50, 50],
            labels: { zone: 'zone-a' },
            config: { min: 0, max: 100, unit: 'percent' },
          },
          {
            name: 'Value',
            type: FieldType.number,
            values: [60, 40],
            labels: { zone: 'zone-b' },
            config: { min: 0, max: 100, unit: 'percent' },
          },
        ],
      }),
    ];
    const rows = normalizeFrames(constrainedFrames, 'lastNotNull');
    const { root } = buildHierarchy(rows, levels);
    const refIds = collectRefIds(rows);
    attachCells(root, rows, levels, 'max', refIds);
    const infos = buildMetricInfos(constrainedFrames, darkTheme, 'utc');
    const tl = buildTimelineIndex(constrainedFrames, root, levels, 'max', refIds)!;

    const deltaRanges = buildDeltaRangeInfos(infos, tl, 60, darkTheme, 'utc');
    const info = deltaRanges.get('A')!;
    expect(info.effectiveMin).toBe(-20);
    expect(info.effectiveMax).toBe(20);
    expect(info.processor(0).color).toBe(divergingColor(0, true));
    expect(info.processor(-20).color).toBe(divergingColor(-1, true));
    expect(info.processor(20).color).toBe(divergingColor(1, true));
  });

  it('expands a constant timeline (min === max === 50) to [50, 51] instead of collapsing to [0, 1]', () => {
    const constFrames = [
      toDataFrame({
        refId: 'A',
        name: 'temp',
        fields: [
          { name: 'Time', type: FieldType.time, values: [0, 60_000] },
          { name: 'Value', type: FieldType.number, values: [50, 50], labels: { zone: 'zone-a' } },
        ],
      }),
    ];
    const rows = normalizeFrames(constFrames, 'lastNotNull');
    const { root } = buildHierarchy(rows, levels);
    const refIds = collectRefIds(rows);
    attachCells(root, rows, levels, 'max', refIds);
    const infos = buildMetricInfos(constFrames, darkTheme, 'utc');
    const tl = buildTimelineIndex(constFrames, root, levels, 'max', refIds)!;

    const rangeInfo = buildTimelineRangeInfos(infos, tl, darkTheme, 'utc').get('A')!;
    expect(rangeInfo.effectiveMin).toBe(50);
    expect(rangeInfo.effectiveMax).toBe(51);
  });

  it('strips raw value mappings, formats prefix units (+$25.0), and suppresses +0.0/-0.0 in delta/zscore processors', () => {
    const mappedFrames = [
      toDataFrame({
        refId: 'A',
        name: 'cost',
        fields: [
          { name: 'Time', type: FieldType.time, values: [0, 60_000] },
          {
            name: 'Value',
            type: FieldType.number,
            values: [10, 35],
            labels: { zone: 'zone-a' },
            config: {
              unit: 'currencyUSD',
              decimals: 1,
              mappings: [{ type: 'value' as never, options: { '0': { text: 'Idle' } } }],
            },
          },
        ],
      }),
    ];
    const rows = normalizeFrames(mappedFrames, 'lastNotNull');
    const { root } = buildHierarchy(rows, levels);
    const refIds = collectRefIds(rows);
    attachCells(root, rows, levels, 'max', refIds);
    const infos = buildMetricInfos(mappedFrames, darkTheme, 'utc');
    const tl = buildTimelineIndex(mappedFrames, root, levels, 'max', refIds)!;

    const proc = buildDeltaRangeInfos(infos, tl, 60, darkTheme, 'utc').get('A')!.processor;
    expect(proc(0).text).toBe('0.0'); // NOT "Idle"
    expect(proc(-0.0001).text).toBe('0.0'); // NOT "-0.0"
    expect(proc(0.0001).text).toBe('0.0'); // NOT "+0.0"
    const pos = proc(25);
    expect(`${pos.prefix ?? ''}${pos.text}`).toBe('+$25.0');

    const zProc = buildZScoreProcessor(-3, 3, 1, darkTheme);
    expect(zProc(-0.0001).text).toBe('0.0');
    expect(zProc(0.0001).text).toBe('0.0');
  });

  it('avoids Float64 overflow in spatial Z-score variance and median for extreme values (~1e160, ~1e308)', () => {
    const large = Float64Array.from([1e160, 2e160, 3e160]);
    const groups = [{ path: ['z1'], cellIndices: [0, 1, 2] }];
    const meanRes = computeSpatialZScores(large, groups, 'mean');
    expect(meanRes.values[0]).toBeCloseTo(-Math.sqrt(1.5), 5);
    expect(meanRes.values[1]).toBeCloseTo(0, 5);
    expect(meanRes.values[2]).toBeCloseTo(Math.sqrt(1.5), 5);

    const huge = Float64Array.from([1e308, 1e308, 1.5e308, 1.5e308]);
    const medRes = computeSpatialZScores(huge, [{ path: ['z1'], cellIndices: [0, 1, 2, 3] }], 'median');
    expect(Number.isFinite(medRes.values[0])).toBe(true);
    expect(medRes.values[0]).toBeLessThan(0);
    expect(medRes.values[3]).toBeGreaterThan(0);
  });
});
