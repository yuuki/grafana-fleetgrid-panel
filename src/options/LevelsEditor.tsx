import React from 'react';
import { DataFrame, FieldType, SelectableValue, StandardEditorProps } from '@grafana/data';
import {
  Button,
  Combobox,
  ComboboxOption,
  IconButton,
  InlineField,
  InlineFieldRow,
  Input,
  RadioButtonGroup,
  Select,
  Switch,
} from '@grafana/ui';
import { DEFAULT_LEVEL, ExtractPreset, LevelDef, LevelLayout, SortOrder } from '../types';
import { extractKey, naturalCompare } from '../data/hierarchy';
import { isTableFrame } from '../data/normalize';
import { normalizeGridColumns } from '../layout/layout';

export function detectLabelKeys(frames: DataFrame[]): string[] {
  const keys = new Set<string>();
  for (const frame of frames) {
    const table = isTableFrame(frame);
    for (const field of frame.fields) {
      if (field.type === FieldType.number && field.labels) {
        Object.keys(field.labels).forEach((k) => keys.add(k));
      }
      if (table && field.type === FieldType.string) {
        keys.add(field.name);
      }
    }
  }
  return [...keys];
}

export function previewLevel(frames: DataFrame[], level: LevelDef): { count: number; samples: string[] } {
  const found = new Set<string>();
  for (const frame of frames) {
    const table = isTableFrame(frame);
    for (const field of frame.fields) {
      if (field.type === FieldType.number && field.labels && level.label in field.labels) {
        const key = extractKey(field.labels[level.label], level);
        if (key !== null) {
          found.add(key);
        }
      }
      if (table && field.type === FieldType.string && field.name === level.label) {
        for (const v of field.values) {
          const key = extractKey(String(v), level);
          if (key !== null) {
            found.add(key);
          }
        }
      }
    }
  }
  const sorted = [...found].sort(naturalCompare);
  return { count: sorted.length, samples: sorted.slice(0, 5) };
}

const EXTRACT_OPTIONS: Array<SelectableValue<ExtractPreset>> = [
  { value: 'raw', label: 'Raw' },
  { value: 'trailingNumber', label: 'Trailing number' },
  { value: 'regex', label: 'Regex' },
];
const SORT_OPTIONS: Array<SelectableValue<SortOrder>> = [
  { value: 'natural', label: 'Ascending' },
  { value: 'naturalDesc', label: 'Descending' },
  { value: 'none', label: 'None' },
];
const LAYOUT_OPTIONS: Array<ComboboxOption<LevelLayout>> = [
  { value: 'vertical', label: 'Vertical stack' },
  { value: 'horizontal', label: 'Horizontal' },
  { value: 'flow', label: 'Flow (wrap)' },
  { value: 'grid', label: 'Grid' },
];

export const LevelsEditor: React.FC<StandardEditorProps<LevelDef[]>> = ({ value, onChange, context }) => {
  const levels = value ?? [];
  const frames = context.data ?? [];
  const labelOptions = detectLabelKeys(frames).map((k) => ({ value: k, label: k }));

  const update = (i: number, patch: Partial<LevelDef>) => {
    const next = levels.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
    onChange(next);
  };
  const move = (i: number, dir: -1 | 1) => {
    const next = [...levels];
    const [item] = next.splice(i, 1);
    next.splice(i + dir, 0, item);
    onChange(next);
  };

  return (
    <div>
      {levels.map((level, i) => {
        const preview = level.label ? previewLevel(frames, level) : null;
        return (
          <div key={i} style={{ marginBottom: 12 }}>
            <InlineFieldRow>
              <InlineField label={`Level ${i + 1}`}>
                <Select
                  options={labelOptions}
                  value={level.label}
                  allowCustomValue
                  onChange={(v) => update(i, { label: v.value ?? '' })}
                  width={20}
                />
              </InlineField>
              <IconButton name="arrow-up" disabled={i === 0} onClick={() => move(i, -1)} tooltip="Move up" />
              <IconButton
                name="arrow-down"
                disabled={i === levels.length - 1}
                onClick={() => move(i, 1)}
                tooltip="Move down"
              />
              <IconButton
                name="trash-alt"
                onClick={() => onChange(levels.filter((_, idx) => idx !== i))}
                tooltip="Delete"
              />
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="Extract">
                <RadioButtonGroup
                  options={EXTRACT_OPTIONS}
                  value={level.extract}
                  onChange={(v) => update(i, { extract: v })}
                />
              </InlineField>
              {level.extract === 'regex' && (
                <InlineField label="Regex">
                  <Input
                    value={level.regex ?? ''}
                    placeholder="node-.+?(\d+)"
                    onChange={(e) => update(i, { regex: e.currentTarget.value })}
                  />
                </InlineField>
              )}
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="Sort">
                <RadioButtonGroup options={SORT_OPTIONS} value={level.sort} onChange={(v) => update(i, { sort: v })} />
              </InlineField>
              <InlineField label="Layout">
                <Combobox
                  options={LAYOUT_OPTIONS}
                  value={level.layout}
                  onChange={(v) => update(i, { layout: v.value })}
                  width={20}
                />
              </InlineField>
              {level.layout === 'grid' && (
                <InlineField label="Columns">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={normalizeGridColumns(level.gridColumns)}
                    onChange={(e) => update(i, { gridColumns: normalizeGridColumns(Number(e.currentTarget.value)) })}
                    width={8}
                  />
                </InlineField>
              )}
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="Border">
                <Switch value={level.showBorder} onChange={(e) => update(i, { showBorder: e.currentTarget.checked })} />
              </InlineField>
              <InlineField label="Show Label">
                <Switch value={level.showLabel} onChange={(e) => update(i, { showLabel: e.currentTarget.checked })} />
              </InlineField>
            </InlineFieldRow>
            {preview && (
              <div style={{ opacity: 0.8, fontSize: 12 }}>
                → {preview.count} groups: {preview.samples.join(', ')}
                {preview.count > preview.samples.length ? ', …' : ''}
                {preview.count === 0 && ' (No matches. Check the settings.)'}
              </div>
            )}
          </div>
        );
      })}
      <Button icon="plus" variant="secondary" onClick={() => onChange([...levels, { ...DEFAULT_LEVEL }])}>
        Add Level
      </Button>
    </div>
  );
};
