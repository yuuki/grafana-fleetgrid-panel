import fc from 'fast-check';
import { CellModel } from '../types';
import { cliffsDelta, compareCohorts, quantile } from './cohort';
import { propertyParams } from '../testing/property';

// The cohort statistics are checked against definitions that are obviously right but slow: a
// quantile bracketed by the neighbouring order statistics, and Cliff's delta counted pair by pair.

// Any finite double, including values whose difference overflows, plus a few repeated values so
// that ties are common.
const value = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(0, -0, 1, 1, 2, 3, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE)
);
const cellValue = fc.oneof({ weight: 5, arbitrary: value }, { weight: 1, arbitrary: fc.constant(null) });

const cellsOf = (values: Array<number | null>): CellModel[] =>
  values.map((v, index) => ({ path: [String(index)], labels: {}, values: new Map([['A', v]]) }));

const ascending = (values: number[]): number[] => [...values].sort((a, b) => a - b);

describe('quantile (properties)', () => {
  it('lies between the order statistics around position q × (n − 1) and grows with q', () => {
    fc.assert(
      fc.property(
        fc.array(value, { minLength: 1, maxLength: 40 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (values, q1, q2) => {
          const sorted = ascending(values);
          const [low, high] = q1 <= q2 ? [q1, q2] : [q2, q1];
          const at = quantile(sorted, low)!;
          const position = low * (sorted.length - 1);
          expect(at).toBeGreaterThanOrEqual(sorted[Math.floor(position)]);
          expect(at).toBeLessThanOrEqual(sorted[Math.ceil(position)]);
          expect(quantile(sorted, high)!).toBeGreaterThanOrEqual(at);
        }
      ),
      propertyParams()
    );
  });
});

describe('cliffsDelta (properties)', () => {
  it('equals the pair count of its definition, is antisymmetric, and is 0 against itself', () => {
    fc.assert(
      fc.property(
        fc.array(value, { minLength: 1, maxLength: 30 }),
        fc.array(value, { minLength: 1, maxLength: 30 }),
        (a, b) => {
          let greater = 0;
          let less = 0;
          for (const x of a) {
            for (const y of b) {
              greater += x > y ? 1 : 0;
              less += x < y ? 1 : 0;
            }
          }
          const delta = cliffsDelta(ascending(a), ascending(b))!;
          expect(delta).toBe((greater - less) / (a.length * b.length));
          expect(delta).toBeGreaterThanOrEqual(-1);
          expect(delta).toBeLessThanOrEqual(1);
          // `+ 0` turns the −0 of a negated zero into 0.
          expect(cliffsDelta(ascending(b), ascending(a))! + 0).toBe(-delta + 0);
          expect(cliffsDelta(ascending(a), ascending(a))).toBe(0);
        }
      ),
      propertyParams()
    );
  });
});

describe('compareCohorts (properties)', () => {
  it('counts every cell once and orders the summary of the cells that have a value', () => {
    fc.assert(
      fc.property(fc.array(cellValue, { maxLength: 40 }), fc.array(cellValue, { maxLength: 40 }), (a, b) => {
        const [comparison] = compareCohorts(cellsOf(a), cellsOf(b), ['A']);
        for (const [values, summary] of [
          [a, comparison.selected],
          [b, comparison.rest],
        ] as const) {
          const present = ascending(values.filter((v): v is number => v !== null));
          expect(summary.count).toBe(present.length);
          expect(summary.missing).toBe(values.length - present.length);
          if (present.length === 0) {
            expect(summary.min).toBeUndefined();
            expect(summary.max).toBeUndefined();
            continue;
          }
          // `+ 0`: the two zeros are the same value, whichever of them a sort puts first.
          expect(summary.min! + 0).toBe(present[0] + 0);
          expect(summary.max! + 0).toBe(present[present.length - 1] + 0);
          expect(summary.median!).toBeGreaterThanOrEqual(summary.min!);
          expect(summary.p95!).toBeGreaterThanOrEqual(summary.median!);
          expect(summary.max!).toBeGreaterThanOrEqual(summary.p95!);
        }
        const bothHaveValues = comparison.selected.count > 0 && comparison.rest.count > 0;
        expect(comparison.delta === undefined).toBe(!bothHaveValues);
      }),
      propertyParams()
    );
  });

  it('does not change when the cells of a cohort come in another order', () => {
    fc.assert(
      fc.property(
        fc
          .array(cellValue, { maxLength: 30 })
          .chain((a) => fc.tuple(fc.constant(a), fc.shuffledSubarray(a, { minLength: a.length }))),
        fc.array(cellValue, { maxLength: 30 }),
        ([a, shuffled], b) => {
          expect(compareCohorts(cellsOf(shuffled), cellsOf(b), ['A'])).toEqual(
            compareCohorts(cellsOf(a), cellsOf(b), ['A'])
          );
        }
      ),
      propertyParams()
    );
  });
});
