import { DataFrame, Field, FieldType } from '@grafana/data';
import { isTableFrame } from '../data/normalize';

export interface RangeOverrideSuggestions {
  refIds: string[];
  valuesByLabel: Record<string, string[]>;
}

const SAMPLE_VALUE_LIMIT = 20;

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

// Records a label even when its sample set is already full, but keeps at most SAMPLE_VALUE_LIMIT values.
function addValue(valuesByLabel: Map<string, Set<string>>, label: string, value: unknown): void {
  const text = String(value);
  const values = valuesByLabel.get(label) ?? new Set<string>();
  if (values.size < SAMPLE_VALUE_LIMIT) {
    values.add(text);
  }
  valuesByLabel.set(label, values);
}

// Samples series label values and, for table frames, string column values keyed by the column name.
function addFieldValues(valuesByLabel: Map<string, Set<string>>, field: Field, table: boolean): void {
  if (field.type === FieldType.number && field.labels) {
    for (const [label, value] of Object.entries(field.labels)) {
      addValue(valuesByLabel, label, value);
    }
  }
  if (table && field.type === FieldType.string) {
    for (const value of field.values) {
      addValue(valuesByLabel, field.name, value);
    }
  }
}

function sortedValuesByLabel(valuesByLabel: Map<string, Set<string>>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const label of sorted(valuesByLabel.keys())) {
    result[label] = sorted(valuesByLabel.get(label) ?? []);
  }
  return result;
}

export function collectRangeOverrideSuggestions(frames: DataFrame[]): RangeOverrideSuggestions {
  const refIds = new Set<string>();
  const valuesByLabel = new Map<string, Set<string>>();

  for (const frame of frames) {
    if (frame.refId) {
      refIds.add(frame.refId);
    }
    const table = isTableFrame(frame);
    for (const field of frame.fields) {
      addFieldValues(valuesByLabel, field, table);
    }
  }

  const result = sortedValuesByLabel(valuesByLabel);
  return { refIds: sorted(refIds), valuesByLabel: result };
}
