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
function pushTableRows(rows: NormalizedRow[], frame: DataFrame, refId: string, valueField: Field | undefined): void {
  if (!valueField) {
    return;
  }
  const stringFields = frame.fields.filter((f) => f.type === FieldType.string);
  for (let i = 0; i < frame.length; i++) {
    const labels: Record<string, string> = {};
    for (const f of stringFields) {
      labels[f.name] = String(f.values[i]);
    }
    rows.push({ labels, value: toFiniteNumberOrNull(valueField.values[i]), refId });
  }
}

// Time series format: one record per numeric field
function pushSeriesRows(rows: NormalizedRow[], numberFields: Field[], refId: string, reduceCalc: string): void {
  for (const field of numberFields) {
    rows.push({
      labels: { ...(field.labels ?? {}) },
      value: reduceToValue(field, reduceCalc),
      refId,
    });
  }
}

export function normalizeFrames(frames: DataFrame[], reduceCalc: string): NormalizedRow[] {
  const rows: NormalizedRow[] = [];
  for (const frame of frames) {
    const refId = frame.refId ?? 'A';
    const numberFields = frame.fields.filter((f) => f.type === FieldType.number);
    if (isTableFrame(frame)) {
      pushTableRows(rows, frame, refId, numberFields[0]);
    } else {
      pushSeriesRows(rows, numberFields, refId, reduceCalc);
    }
  }
  return rows;
}

function reduceToValue(field: Field, reduceCalc: string): number | null {
  const stats = reduceField({ field, reducers: [reduceCalc] });
  const v = stats[reduceCalc];
  // Preserve the contract (number|null) even when a non-numeric reducer like allValues is specified
  return typeof v !== 'number' || Number.isNaN(v) ? null : v;
}
