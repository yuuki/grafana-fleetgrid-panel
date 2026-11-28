import { CellModel } from '../types';

/** Summary of the values one cohort of cells has for one query. */
export interface CohortSummary {
  /** Cells with a value. */
  count: number;
  /** Cells with no value. They are left out of every statistic: an unknown value is not zero. */
  missing: number;
  min?: number;
  median?: number;
  p95?: number;
  max?: number;
}

export interface MetricComparison {
  refId: string;
  selected: CohortSummary;
  rest: CohortSummary;
  /** Cliff's delta of the selected cells against the rest. Undefined when either side has no value. */
  delta?: number;
}

/**
 * Quantile `q` (0 to 1) of values in ascending order: the value at position `q × (n − 1)`, interpolated
 * linearly between its two neighbours. This is the definition that NumPy, R (type 7), spreadsheets
 * (PERCENTILE.INC) and PromQL's `quantile` use. It is defined for any `n ≥ 1`: one value is every
 * quantile of itself, and in a small cohort p95 lies between the two highest values.
 */
export function quantile(sorted: ArrayLike<number>, q: number): number | undefined {
  const n = sorted.length;
  if (n === 0) {
    return undefined;
  }
  const position = Math.min(Math.max(q, 0), 1) * (n - 1);
  const index = Math.floor(position);
  const fraction = position - index;
  const low = sorted[index];
  if (fraction === 0 || index + 1 >= n) {
    return low;
  }
  const high = sorted[index + 1];
  // Weighted sum, not low + (high - low) × fraction: the difference of two finite values can overflow.
  const value = low * (1 - fraction) + high * fraction;
  return Math.min(Math.max(value, low), high);
}

/**
 * Cliff's delta of `a` against `b` (both ascending): over all pairs (x from a, y from b), the share
 * with x > y minus the share with x < y.
 *
 *   δ = (#{x > y} − #{x < y}) / (|a| × |b|)        −1 ≤ δ ≤ 1
 *
 * +1: every value of `a` is above every value of `b` (the two do not overlap). −1: every value is
 * below. 0: a value of `a` is as likely to be above as below a value of `b`, as for two identical
 * distributions. It uses only the order of the values, so it needs no bins, no unit and no assumption
 * about the distribution, and an outlier counts as one value. Ties count for neither side.
 */
export function cliffsDelta(a: ArrayLike<number>, b: ArrayLike<number>): number | undefined {
  if (a.length === 0 || b.length === 0) {
    return undefined;
  }
  let below = 0; // values of b lower than the current value of a
  let notAbove = 0; // values of b lower than or equal to it
  let greater = 0;
  let less = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    while (below < b.length && b[below] < x) {
      below++;
    }
    notAbove = Math.max(notAbove, below);
    while (notAbove < b.length && b[notAbove] <= x) {
      notAbove++;
    }
    greater += below;
    less += b.length - notAbove;
  }
  return (greater - less) / (a.length * b.length);
}

// The cohort's finite values for one query, ascending, and the number of cells without one.
function cohortValues(cells: CellModel[], refId: string): { sorted: Float64Array; missing: number } {
  const values = new Float64Array(cells.length);
  let count = 0;
  for (const cell of cells) {
    const value = cell.values.get(refId);
    if (typeof value === 'number' && Number.isFinite(value)) {
      values[count++] = value;
    }
  }
  return { sorted: values.subarray(0, count).sort(), missing: cells.length - count };
}

function summarize(sorted: Float64Array, missing: number): CohortSummary {
  if (sorted.length === 0) {
    return { count: 0, missing };
  }
  return {
    count: sorted.length,
    missing,
    min: sorted[0],
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Compares the selected cells with the rest, query by query. The value of a cell is the one the grid
 * shows: reduced over time and aggregated over the series that fall into the cell.
 *
 * Cost: one sort per query and cohort, O(queries × cells × log cells). The panel runs it when the
 * comparison is opened or its inputs change, never while the pointer moves.
 */
export function compareCohorts(selected: CellModel[], rest: CellModel[], refIds: string[]): MetricComparison[] {
  return refIds.map((refId) => {
    const a = cohortValues(selected, refId);
    const b = cohortValues(rest, refId);
    return {
      refId,
      selected: summarize(a.sorted, a.missing),
      rest: summarize(b.sorted, b.missing),
      delta: cliffsDelta(a.sorted, b.sorted),
    };
  });
}
