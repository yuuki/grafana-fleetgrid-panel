import React from 'react';
import { DataFrame, FieldType, SelectableValue, StandardEditorProps } from '@grafana/data';
import { Button, IconButton, InlineField, InlineFieldRow, Input, RadioButtonGroup, Select, Switch } from '@grafana/ui';
import { DEFAULT_LEVEL, ExtractPreset, LevelDef, LevelLayout, SortOrder } from '../types';
import { extractKey, naturalCompare } from '../data/hierarchy';
import { isTableFrame } from '../data/normalize';

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
  { value: 'raw', label: 'そのまま' },
  { value: 'trailingNumber', label: '末尾の数値' },
  { value: 'regex', label: '正規表現' },
];
const SORT_OPTIONS: Array<SelectableValue<SortOrder>> = [
  { value: 'natural', label: '昇順' },
  { value: 'naturalDesc', label: '降順' },
  { value: 'none', label: 'なし' },
];
const LAYOUT_OPTIONS: Array<SelectableValue<LevelLayout>> = [
  { value: 'vertical', label: '縦積み' },
  { value: 'horizontal', label: '横並び' },
  { value: 'flow', label: '折返し' },
  { value: 'grid', label: 'グリッド' },
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
              <InlineField label={`レベル ${i + 1}`}>
                <Select
                  options={labelOptions}
                  value={level.label}
                  allowCustomValue
                  onChange={(v) => update(i, { label: v.value ?? '' })}
                  width={20}
                />
              </InlineField>
              <IconButton name="arrow-up" disabled={i === 0} onClick={() => move(i, -1)} tooltip="上へ" />
              <IconButton
                name="arrow-down"
                disabled={i === levels.length - 1}
                onClick={() => move(i, 1)}
                tooltip="下へ"
              />
              <IconButton
                name="trash-alt"
                onClick={() => onChange(levels.filter((_, idx) => idx !== i))}
                tooltip="削除"
              />
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="抽出">
                <RadioButtonGroup
                  options={EXTRACT_OPTIONS}
                  value={level.extract}
                  onChange={(v) => update(i, { extract: v })}
                />
              </InlineField>
              {level.extract === 'regex' && (
                <InlineField label="正規表現">
                  <Input
                    value={level.regex ?? ''}
                    placeholder="node-.+?(\d+)"
                    onChange={(e) => update(i, { regex: e.currentTarget.value })}
                  />
                </InlineField>
              )}
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="ソート">
                <RadioButtonGroup options={SORT_OPTIONS} value={level.sort} onChange={(v) => update(i, { sort: v })} />
              </InlineField>
              <InlineField label="レイアウト">
                <RadioButtonGroup
                  options={LAYOUT_OPTIONS}
                  value={level.layout}
                  onChange={(v) => update(i, { layout: v })}
                />
              </InlineField>
              {level.layout === 'grid' && (
                <InlineField label="列数">
                  <Input
                    type="number"
                    value={level.gridColumns ?? 1}
                    onChange={(e) => update(i, { gridColumns: Number(e.currentTarget.value) })}
                    width={8}
                  />
                </InlineField>
              )}
            </InlineFieldRow>
            <InlineFieldRow>
              <InlineField label="枠線">
                <Switch value={level.showBorder} onChange={(e) => update(i, { showBorder: e.currentTarget.checked })} />
              </InlineField>
              <InlineField label="ラベル表示">
                <Switch value={level.showLabel} onChange={(e) => update(i, { showLabel: e.currentTarget.checked })} />
              </InlineField>
            </InlineFieldRow>
            {preview && (
              <div style={{ opacity: 0.8, fontSize: 12 }}>
                → {preview.count}グループ: {preview.samples.join(', ')}
                {preview.count > preview.samples.length ? ', …' : ''}
                {preview.count === 0 && ' (マッチしません。設定を確認してください)'}
              </div>
            )}
          </div>
        );
      })}
      <Button icon="plus" variant="secondary" onClick={() => onChange([...levels, { ...DEFAULT_LEVEL }])}>
        レベル追加
      </Button>
    </div>
  );
};
