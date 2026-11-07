import fc from 'fast-check';
import { FieldType, ReducerID, toDataFrame } from '@grafana/data';
import { normalizeFrames } from './normalize';
import { propertyParams } from '../testing/property';

// The numeric reducers the panel offers (ReduceCalcEditor's allowlist).
const REDUCERS = [
  ReducerID.lastNotNull,
  ReducerID.last,
  ReducerID.mean,
  ReducerID.min,
  ReducerID.max,
  ReducerID.sum,
  ReducerID.count,
];

// fc.double() includes NaN, ±Infinity, -0 and the extreme magnitudes: exactly the samples a
// data source can hand over (Prometheus returns +Inf/-Inf/NaN for e.g. x/0 or histogram_quantile).
const sample = fc.oneof(fc.double(), fc.constant(null));
const labelName = fc.constantFrom('zone', 'host', 'gpu', 'pod');
const labelValue = fc.string({ maxLength: 6 });
const labels = fc.dictionary(labelName, labelValue, { minKeys: 1, maxKeys: 4 });
const refId = fc.constantFrom('A', 'B');

/** A time-series frame: one time field and 1-3 labeled numeric series of `length` samples. */
const seriesFrame = fc.integer({ min: 0, max: 8 }).chain((length) =>
  fc.record({
    refId,
    series: fc.array(
      fc.record({ labels, values: fc.array(sample, { minLength: length, maxLength: length }) }),
      { minLength: 1, maxLength: 3 }
    ),
    length: fc.constant(length),
  })
);

/** A table frame (instant query, format: table): 1-3 string label columns and one numeric column. */
const tableFrame = fc.integer({ min: 0, max: 8 }).chain((length) =>
  fc.record({
    refId,
    columns: fc.uniqueArray(labelName, { minLength: 1, maxLength: 3 }).chain((names) =>
      fc.tuple(...names.map((name) => fc.array(labelValue, { minLength: length, maxLength: length }).map((values) => ({ name, values }))))
    ),
    values: fc.array(sample, { minLength: length, maxLength: length }),
    length: fc.constant(length),
  })
);

const isFiniteOrNull = (v: number | null) => v === null || Number.isFinite(v);

describe('normalizeFrames (properties)', () => {
  it('reduces each time series to one row whose value is finite or null', () => {
    fc.assert(
      fc.property(seriesFrame, fc.constantFrom(...REDUCERS), (f, reducer) => {
        const frame = toDataFrame({
          refId: f.refId,
          fields: [
            { name: 'Time', type: FieldType.time, values: Array.from({ length: f.length }, (_, i) => 1000 * (i + 1)) },
            ...f.series.map((s, i) => ({ name: `Value ${i}`, type: FieldType.number, values: s.values, labels: s.labels })),
          ],
        });
        const rows = normalizeFrames([frame], reducer);
        expect(rows).toHaveLength(f.series.length);
        rows.forEach((row, i) => {
          expect(row.refId).toBe(f.refId);
          expect(row.labels).toEqual(f.series[i].labels);
          expect(isFiniteOrNull(row.value)).toBe(true);
        });
      }),
      propertyParams()
    );
  });

  it('turns every table row into one row whose value is finite or null', () => {
    fc.assert(
      fc.property(tableFrame, fc.constantFrom(...REDUCERS), (f, reducer) => {
        const frame = toDataFrame({
          refId: f.refId,
          fields: [
            ...f.columns.map((c) => ({ name: c.name, type: FieldType.string, values: c.values })),
            { name: 'Value', type: FieldType.number, values: f.values },
          ],
        });
        const rows = normalizeFrames([frame], reducer);
        expect(rows).toHaveLength(f.length);
        rows.forEach((row, i) => {
          expect(row.refId).toBe(f.refId);
          expect(row.labels).toEqual(Object.fromEntries(f.columns.map((c) => [c.name, c.values[i]])));
          expect(isFiniteOrNull(row.value)).toBe(true);
          const raw = f.values[i];
          // Finite samples pass through unchanged; missing and non-finite samples become null.
          expect(row.value).toBe(raw !== null && Number.isFinite(raw) ? raw : null);
        });
      }),
      propertyParams()
    );
  });
});
