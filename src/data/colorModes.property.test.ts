import fc from 'fast-check';
import { propertyParams } from '../testing/property';
import { computeSpatialZScores, valueToDivergingRatio } from './colorModes';

describe('colorModes properties', () => {
  it('valueToDivergingRatio is always finite in [-1, 1], monotonic, and maps 0 to 0 when straddling zero', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: -1e-3, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1e-3, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -2e6, max: 2e6, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -2e6, max: 2e6, noNaN: true, noDefaultInfinity: true }),
        (min, max, a, b) => {
          expect(valueToDivergingRatio(0, min, max)).toBe(0);
          const ra = valueToDivergingRatio(a, min, max);
          const rb = valueToDivergingRatio(b, min, max);
          expect(Number.isFinite(ra)).toBe(true);
          expect(ra).toBeGreaterThanOrEqual(-1);
          expect(ra).toBeLessThanOrEqual(1);
          if (a <= b) {
            expect(ra).toBeLessThanOrEqual(rb);
          }
        }
      ),
      propertyParams()
    );
  });

  it('mean-method spatial Z-scores have mean ~0 and unit RMS when sibling values vary', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e4, max: 1e4, noNaN: true, noDefaultInfinity: true }), {
          minLength: 2,
          maxLength: 32,
        }),
        (vals) => {
          const raw = Float64Array.from(vals);
          const groups = [{ path: ['g'], cellIndices: vals.map((_, i) => i) }];
          const res = computeSpatialZScores(raw, groups, 'mean');
          let sum = 0;
          let sqSum = 0;
          for (let i = 0; i < vals.length; i++) {
            expect(Number.isFinite(res.values[i])).toBe(true);
            sum += res.values[i];
            sqSum += res.values[i] * res.values[i];
          }
          const allEqual = vals.every((v) => v === vals[0]);
          if (allEqual) {
            expect(sqSum).toBe(0);
          } else if (res.statsByCell[0] && res.statsByCell[0].spread > 1e-9) {
            expect(Math.abs(sum / vals.length)).toBeLessThan(1e-7);
            expect(Math.sqrt(sqSum / vals.length)).toBeCloseTo(1, 5);
          }
        }
      ),
      propertyParams()
    );
  });
});
