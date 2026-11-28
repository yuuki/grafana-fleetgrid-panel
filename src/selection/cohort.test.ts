import { CellModel } from '../types';
import { cliffsDelta, compareCohorts, quantile } from './cohort';

const cells = (refId: string, values: Array<number | null>): CellModel[] =>
  values.map((value, index) => ({ path: [String(index)], labels: {}, values: new Map([[refId, value]]) }));

describe('quantile', () => {
  it('interpolates linearly at position q × (n − 1)', () => {
    const sorted = [10, 20, 30, 40];
    expect(quantile(sorted, 0)).toBe(10);
    expect(quantile(sorted, 1)).toBe(40);
    expect(quantile(sorted, 0.5)).toBe(25);
    // position 0.95 × 3 = 2.85: between 30 and 40
    expect(quantile(sorted, 0.95)).toBeCloseTo(38.5, 10);
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
  });

  it('is defined for one value and undefined for none', () => {
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([7], 0.95)).toBe(7);
    expect(quantile([], 0.5)).toBeUndefined();
  });

  it('stays between its two neighbours when their difference overflows', () => {
    const q = quantile([-Number.MAX_VALUE, Number.MAX_VALUE], 0.75)!;
    expect(Number.isFinite(q)).toBe(true);
    expect(q).toBeGreaterThan(0);
  });

  it('clamps q to 0..1', () => {
    expect(quantile([1, 2, 3], -1)).toBe(1);
    expect(quantile([1, 2, 3], 2)).toBe(3);
  });
});

describe('cliffsDelta', () => {
  it('is +1 or −1 when the two groups do not overlap', () => {
    expect(cliffsDelta([5, 6, 7], [1, 2, 3])).toBe(1);
    expect(cliffsDelta([1, 2, 3], [5, 6, 7])).toBe(-1);
  });

  it('is 0 for identical distributions and for constant ones', () => {
    expect(cliffsDelta([1, 2, 3, 4], [1, 2, 3, 4])).toBe(0);
    expect(cliffsDelta([5, 5, 5], [5, 5])).toBe(0);
  });

  it('counts pairs: ties for neither side', () => {
    // Pairs (x, y) with x from [1, 3], y from [2, 3]: 1<2, 1<3, 3>2, 3=3 → (1 − 2) / 4
    expect(cliffsDelta([1, 3], [2, 3])).toBe(-0.25);
    // One selected value above 3 of 4 others and below 1: (3 − 1) / 4
    expect(cliffsDelta([35], [10, 20, 30, 40])).toBe(0.5);
  });

  it('is 0 when a group has both extremes of the other group around it', () => {
    expect(cliffsDelta([0, 100], [50, 50])).toBe(0);
  });

  it('is undefined when either group has no value', () => {
    expect(cliffsDelta([], [1])).toBeUndefined();
    expect(cliffsDelta([1], [])).toBeUndefined();
  });
});

describe('compareCohorts', () => {
  it('summarizes each cohort per query and compares them', () => {
    const [comparison] = compareCohorts(cells('A', [300, 310, 320]), cells('A', [100, 200, 150, 250]), ['A']);
    expect(comparison).toEqual({
      refId: 'A',
      selected: { count: 3, missing: 0, min: 300, median: 310, p95: 319, max: 320 },
      rest: { count: 4, missing: 0, min: 100, median: 175, p95: 242.5, max: 250 },
      delta: 1,
    });
  });

  it('counts cells without a value and keeps them out of the statistics', () => {
    const [comparison] = compareCohorts(cells('A', [null, 4, null]), cells('A', [0, 2]), ['A']);
    // If the two missing cells counted as 0, the minimum would be 0 and the median 0.
    expect(comparison.selected).toEqual({ count: 1, missing: 2, min: 4, median: 4, p95: 4, max: 4 });
    expect(comparison.rest).toEqual({ count: 2, missing: 0, min: 0, median: 1, p95: 1.9, max: 2 });
    expect(comparison.delta).toBe(1);
  });

  it('treats a query that a cell does not have, and a non-finite value, as no value', () => {
    const selected: CellModel[] = [
      { path: ['a'], labels: {}, values: new Map() },
      { path: ['b'], labels: {}, values: new Map([['B', Number.NaN]]) },
      { path: ['c'], labels: {}, values: new Map([['B', Number.POSITIVE_INFINITY]]) },
    ];
    const [comparison] = compareCohorts(selected, cells('B', [1]), ['B']);
    expect(comparison.selected).toEqual({ count: 0, missing: 3 });
    expect(comparison.delta).toBeUndefined();
  });

  it('handles an empty selection, a selection of everything and a selection of one cell', () => {
    const all = cells('A', [1, 2, 3]);
    expect(compareCohorts([], all, ['A'])[0]).toMatchObject({ selected: { count: 0, missing: 0 }, delta: undefined });
    expect(compareCohorts(all, [], ['A'])[0]).toMatchObject({ rest: { count: 0, missing: 0 }, delta: undefined });
    const one = compareCohorts(cells('A', [3]), cells('A', [1, 2]), ['A'])[0];
    expect(one.selected).toEqual({ count: 1, missing: 0, min: 3, median: 3, p95: 3, max: 3 });
    expect(one.delta).toBe(1);
  });

  it('reports every query, in the order given, including one without any value', () => {
    const selected: CellModel[] = [
      {
        path: ['a'],
        labels: {},
        values: new Map<string, number | null>([
          ['A', 1],
          ['B', null],
        ]),
      },
    ];
    const rest: CellModel[] = [
      {
        path: ['b'],
        labels: {},
        values: new Map<string, number | null>([
          ['A', 1],
          ['B', null],
        ]),
      },
    ];
    const comparisons = compareCohorts(selected, rest, ['B', 'A']);
    expect(comparisons.map((c) => c.refId)).toEqual(['B', 'A']);
    expect(comparisons[0]).toEqual({
      refId: 'B',
      selected: { count: 0, missing: 1 },
      rest: { count: 0, missing: 1 },
      delta: undefined,
    });
    // Identical distributions.
    expect(comparisons[1].delta).toBe(0);
  });
});
