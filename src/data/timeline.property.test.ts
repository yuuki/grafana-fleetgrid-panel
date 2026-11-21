import fc from 'fast-check';
import { FieldType, toDataFrame } from '@grafana/data';
import { propertyParams } from '../testing/property';
import { DEFAULT_LEVEL, LevelDef, SpatialAggregation } from '../types';
import { buildHierarchy } from './hierarchy';
import { normalizeFrames } from './normalize';
import { attachCells, collectRefIds } from './values';
import { buildTimelineIndex, findLookbackIndex } from './timeline';

const levels: LevelDef[] = [{ ...DEFAULT_LEVEL, label: 'zone' }];

describe('timeline properties', () => {
  it('findLookbackIndex always returns the maximal index j < i satisfying ts[j] <= ts[i] - lookbackMs', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 2, maxLength: 30 }),
        fc.integer({ min: 0, max: 500 }),
        (rawTs, lookbackSec) => {
          const sorted = [...rawTs].sort((a, b) => a - b).map((s) => s * 1000);
          const timestamps = Float64Array.from(sorted);
          for (let i = 0; i < timestamps.length; i++) {
            const found = findLookbackIndex(timestamps, i, lookbackSec);
            if (i === 0) {
              expect(found).toBe(-1);
              continue;
            }
            if (lookbackSec === 0) {
              expect(found).toBe(i - 1);
              continue;
            }
            const target = timestamps[i] - lookbackSec * 1000;
            if (found === -1) {
              expect(timestamps[0]).toBeGreaterThan(target);
            } else {
              expect(found).toBeGreaterThanOrEqual(0);
              expect(found).toBeLessThan(i);
              expect(timestamps[found]).toBeLessThanOrEqual(target);
              if (found + 1 < i) {
                expect(timestamps[found + 1]).toBeGreaterThan(target);
              }
            }
          }
        }
      ),
      propertyParams()
    );
  });

  it('buildTimelineIndex produces strictly increasing timestamps and bounded finite values', () => {
    const aggArb = fc.constantFrom<SpatialAggregation>('max', 'min', 'sum', 'mean');
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 100_000 }), { minLength: 2, maxLength: 15 }),
        fc.array(fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }), {
          minLength: 2,
          maxLength: 15,
        }),
        aggArb,
        (times, rawVals, agg) => {
          const len = Math.min(times.length, rawVals.length);
          const tSlice = times.slice(0, len);
          const vSlice = rawVals.slice(0, len);
          const frame = toDataFrame({
            refId: 'A',
            fields: [
              { name: 'Time', type: FieldType.time, values: tSlice },
              { name: 'Value', type: FieldType.number, values: vSlice, labels: { zone: 'zone-a' } },
            ],
          });
          const rows = normalizeFrames([frame], 'lastNotNull');
          const { root } = buildHierarchy(rows, levels);
          const refIds = collectRefIds(rows);
          attachCells(root, rows, levels, agg, refIds);
          const tl = buildTimelineIndex([frame], root, levels, agg, refIds)!;

          expect(tl).toBeDefined();
          for (let i = 1; i < tl.timestamps.length; i++) {
            expect(tl.timestamps[i]).toBeGreaterThan(tl.timestamps[i - 1]);
          }
          const arr = tl.valuesByRef.get('A')!;
          const range = tl.rangeByRef.get('A')!;
          for (let i = 0; i < arr.length; i++) {
            if (Number.isFinite(arr[i])) {
              expect(arr[i]).toBeGreaterThanOrEqual(range.min);
              expect(arr[i]).toBeLessThanOrEqual(range.max);
            }
          }
        }
      ),
      propertyParams()
    );
  });
});
