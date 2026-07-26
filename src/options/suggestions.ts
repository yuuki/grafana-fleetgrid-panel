import { DataFrame, FieldType } from '@grafana/data';
import { isTableFrame } from '../data/normalize';

export interface RangeOverrideSuggestions {
  refIds: string[];
  valuesByLabel: Record<string, string[]>;
}

const SAMPLE_VALUE_LIMIT = 20;

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function collectRangeOverrideSuggestions(frames: DataFrame[]): RangeOverrideSuggestions {
  const refIds = new Set<string>();
  const valuesByLabel = new Map<string, Set<string>>();
  const addValue = (label: string, value: unknown) => {
    const text = String(value);
    const values = valuesByLabel.get(label) ?? new Set<string>();
    if (values.size < SAMPLE_VALUE_LIMIT) {
      values.add(text);
    }
    valuesByLabel.set(label, values);
  };

  for (const frame of frames) {
    if (frame.refId) {
      refIds.add(frame.refId);
    }
    const table = isTableFrame(frame);
    for (const field of frame.fields) {
      if (field.type === FieldType.number && field.labels) {
        for (const [label, value] of Object.entries(field.labels)) {
          addValue(label, value);
        }
      }
      if (table && field.type === FieldType.string) {
        for (const value of field.values) {
          addValue(field.name, value);
        }
      }
    }
  }

  const result: Record<string, string[]> = {};
  for (const label of sorted(valuesByLabel.keys())) {
    result[label] = sorted(valuesByLabel.get(label) ?? []);
  }
  return { refIds: sorted(refIds), valuesByLabel: result };
}
