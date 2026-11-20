import { DataFrame, Field, FieldType, reduceField } from '@grafana/data';
import { NormalizedRow } from '../types';

/**
 * Is this a table format where labels are expanded into columns?
 * Prometheus/VictoriaMetrics's instant+format=table includes a Time column, so the presence of a Time column is not used for judgment.
 * The basis for determining table format is "there is a string column, and the numeric field has no labels."
 */
export function isTableFrame(frame: DataFrame): boolean {
  const hasLabeledNumber = frame.fields.some(
    (f) => f.type === FieldType.number && f.labels && Object.keys(f.labels).length > 0
  );
  const hasStringColumn = frame.fields.some((f) => f.type === FieldType.string);
  return hasStringColumn && !hasLabeledNumber;
}

// Values that can't be numerified or are non-finite (NaN/Infinity) are normalized to null as missing
function toFiniteNumberOrNull(raw: unknown): number | null {
  const num = raw == null ? null : Number(raw);
  return num != null && Number.isFinite(num) ? num : null;
}

// Table format: one record per row, labeled by the frame's string columns, valued by its first numeric field
function pushTableRows(
  rows: NormalizedRow[],
  frame: DataFrame,
  refId: string,
  valueField: Field | undefined,
  maxRows: number
): void {
  if (!valueField) {
    return;
  }
  const stringFields = frame.fields.filter((f) => f.type === FieldType.string);
  for (let i = 0; i < frame.length && rows.length < maxRows; i++) {
    const labels: Record<string, string> = {};
    for (const f of stringFields) {
      labels[f.name] = String(f.values[i]);
    }
    rows.push({ labels, value: toFiniteNumberOrNull(valueField.values[i]), refId });
  }
}

// Time series format: one record per numeric field
function pushSeriesRows(
  rows: NormalizedRow[],
  numberFields: Field[],
  refId: string,
  reduceCalc: string,
  maxRows: number
): void {
  for (const field of numberFields) {
    if (rows.length >= maxRows) {
      return;
    }
    rows.push({
      labels: { ...(field.labels ?? {}) },
      value: reduceToValue(field, reduceCalc),
      refId,
    });
  }
}

/**
 * `maxRows` stops the scan after that many rows. The cell pipeline reads every row; the flow overlay
 * bounds its work with it, because pairwise (edge) data grows with the square of the fleet.
 */
export function normalizeFrames(frames: DataFrame[], reduceCalc: string, maxRows = Infinity): NormalizedRow[] {
  const rows: NormalizedRow[] = [];
  for (const frame of frames) {
    if (rows.length >= maxRows) {
      break;
    }
    const refId = frame.refId ?? 'A';
    const numberFields = frame.fields.filter((f) => f.type === FieldType.number);
    if (isTableFrame(frame)) {
      pushTableRows(rows, frame, refId, numberFields[0], maxRows);
    } else {
      pushSeriesRows(rows, numberFields, refId, reduceCalc, maxRows);
    }
  }
  return rows;
}

/** The number of rows normalizeFrames returns for these frames without a limit, counted without building them. */
export function countFrameRows(frames: DataFrame[]): number {
  let count = 0;
  for (const frame of frames) {
    let numberFields = 0;
    for (const field of frame.fields) {
      numberFields += field.type === FieldType.number ? 1 : 0;
    }
    if (isTableFrame(frame)) {
      count += numberFields > 0 ? frame.length : 0;
    } else {
      count += numberFields;
    }
  }
  return count;
}

function reduceToValue(field: Field, reduceCalc: string): number | null {
  const stats = reduceField({ field, reducers: [reduceCalc] });
  const v = stats[reduceCalc];
  // Preserve the contract (number|null) even when a non-numeric reducer like allValues is specified.
  // A non-finite result (lastNotNull over a +Inf sample, or a sum/mean that overflows) is missing,
  // exactly as on the table path, so it cannot leak into spatial aggregation or range computation.
  return typeof v === 'number' ? toFiniteNumberOrNull(v) : null;
}
