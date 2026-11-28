import { DataFrame, Field, FieldType } from '@grafana/data';
import { flowRefId, frameHasRefId } from '../data/edges';
import { isTableFrame } from '../data/normalize';
import { FleetGridOptions } from '../types';

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

/**
 * The frames that the cells are built from: all frames but those of the flow overlay's edge query. The
 * edge query's labels (the names of the two ends, hop numbers) are not labels of a cell, and its refId
 * is not a cell metric, so the editors of the cell options do not offer them. The frames are returned
 * as they are while no edge query is named.
 */
export function cellFrames(
  frames: DataFrame[] | undefined,
  options: Pick<FleetGridOptions, 'flowRefId'> | undefined
): DataFrame[] {
  const all = frames ?? [];
  const refId = flowRefId(options ?? {});
  return refId === '' ? all : all.filter((frame) => !frameHasRefId(frame, refId));
}

/**
 * The names that can be used as a label of the frames: the labels of series, and the string columns of
 * tables. Reads the fields only, never a value, so it is cheap for a result of any number of rows.
 */
export function collectLabelNames(frames: DataFrame[]): string[] {
  const names = new Set<string>();
  for (const frame of frames) {
    const table = isTableFrame(frame);
    for (const field of frame.fields) {
      if (field.type === FieldType.number && field.labels) {
        Object.keys(field.labels).forEach((name) => names.add(name));
      }
      if (table && field.type === FieldType.string) {
        names.add(field.name);
      }
    }
  }
  return sorted(names);
}
