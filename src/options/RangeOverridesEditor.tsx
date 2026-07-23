import React from 'react';
import { DataFrame, FieldType, SelectableValue, StandardEditorProps } from '@grafana/data';
import {
  Button,
  FieldValidationMessage,
  IconButton,
  InlineField,
  InlineFieldRow,
  Input,
  RadioButtonGroup,
} from '@grafana/ui';
import { RangeMatcher, RangeMatcherOperator, RangeOverride } from '../types';
import { isTableFrame } from '../data/normalize';

interface RangeOverrideSuggestions {
  refIds: string[];
  valuesByLabel: Record<string, string[]>;
}

interface RangeMatcherView {
  label: string;
  operator: string;
  value: string;
}

interface RangeRuleView {
  refId?: unknown;
  matchers: RangeMatcherView[];
  min?: unknown;
  max?: unknown;
}

const EMPTY_MATCHER: RangeMatcher = { label: '', operator: 'exact', value: '' };
const SAMPLE_VALUE_LIMIT = 20;
const OPERATOR_OPTIONS: Array<SelectableValue<RangeMatcherOperator>> = [
  { label: 'Exact', value: 'exact' },
  { label: 'Regex', value: 'regex' },
];

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMatcher(value: unknown): RangeMatcherView {
  if (!isRecord(value)) {
    return { ...EMPTY_MATCHER };
  }
  return {
    label: typeof value.label === 'string' ? value.label : '',
    operator: typeof value.operator === 'string' ? value.operator : '',
    value: typeof value.value === 'string' ? value.value : '',
  };
}

function normalizedMatchers(value: unknown): RangeMatcherView[] {
  if (!isRecord(value)) {
    return [];
  }
  const matchers = value.matchers;
  return Array.isArray(matchers) ? matchers.map(normalizeMatcher) : [];
}

function normalizeRule(value: unknown): RangeRuleView {
  if (!isRecord(value)) {
    return { matchers: [{ ...EMPTY_MATCHER }], min: undefined, max: undefined };
  }
  return { ...value, matchers: normalizedMatchers(value) };
}

function hasInvalidRegex(matcher: RangeMatcherView): boolean {
  if (matcher.operator !== 'regex') {
    return false;
  }
  try {
    new RegExp(matcher.value);
    return false;
  } catch {
    return true;
  }
}

export function validateRangeOverride(value: unknown): string[] {
  const errors: string[] = [];
  const rule = isRecord(value) ? value : {};
  const matchers = normalizedMatchers(value);
  if (rule.refId !== undefined && typeof rule.refId !== 'string') {
    errors.push('Metric refId must be a string.');
  }
  if (matchers.length === 0) {
    errors.push('Add at least one label condition.');
  }
  for (const matcher of matchers) {
    if (!matcher.label.trim()) {
      errors.push('Label name is required.');
    }
    if (matcher.operator !== 'exact' && matcher.operator !== 'regex') {
      errors.push('Operator must be exact or regex.');
    }
    if (hasInvalidRegex(matcher)) {
      errors.push('Invalid regular expression.');
    }
  }

  const hasMin = rule.min !== undefined;
  const hasMax = rule.max !== undefined;
  if (!hasMin && !hasMax) {
    errors.push('Set min or max.');
  }
  if (hasMin && (typeof rule.min !== 'number' || !Number.isFinite(rule.min))) {
    errors.push('Min must be a finite number.');
  }
  if (hasMax && (typeof rule.max !== 'number' || !Number.isFinite(rule.max))) {
    errors.push('Max must be a finite number.');
  }
  if (
    typeof rule.min === 'number' &&
    Number.isFinite(rule.min) &&
    typeof rule.max === 'number' &&
    Number.isFinite(rule.max) &&
    rule.min >= rule.max
  ) {
    errors.push('Min must be less than max.');
  }
  return [...new Set(errors)];
}

function optionalNumber(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value);
}

function inputValue(value: unknown): string | number {
  return typeof value === 'number' && Number.isFinite(value) ? value : '';
}

export const RangeOverridesEditor: React.FC<StandardEditorProps<RangeOverride[]>> = ({ value, onChange, context }) => {
  const rawRules: unknown[] = Array.isArray(value) ? value : [];
  const rules = rawRules.map(normalizeRule);
  const suggestions = React.useMemo(() => collectRangeOverrideSuggestions(context.data ?? []), [context.data]);
  const labels = Object.keys(suggestions.valuesByLabel);
  const instanceId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '-');
  const refIdsListId = `range-override-refids-${instanceId}`;
  const labelsListId = `range-override-labels-${instanceId}`;

  const emit = (next: unknown[]) => onChange(next as RangeOverride[]);

  const updateRule = (index: number, patch: Record<string, unknown>) => {
    emit(
      rawRules.map((rawRule, current) =>
        current === index ? { ...(isRecord(rawRule) ? rawRule : normalizeRule(rawRule)), ...patch } : rawRule
      )
    );
  };
  const updateMatcher = (ruleIndex: number, matcherIndex: number, patch: Partial<RangeMatcher>) => {
    const rawRule = rawRules[ruleIndex];
    const rawMatchers =
      isRecord(rawRule) && Array.isArray(rawRule.matchers) ? rawRule.matchers : rules[ruleIndex].matchers;
    const matchers = rawMatchers.map((rawMatcher, current) =>
      current === matcherIndex
        ? { ...(isRecord(rawMatcher) ? rawMatcher : normalizeMatcher(rawMatcher)), ...patch }
        : rawMatcher
    );
    updateRule(ruleIndex, { matchers });
  };
  const moveRule = (index: number, direction: -1 | 1) => {
    const next = [...rawRules];
    const [rule] = next.splice(index, 1);
    next.splice(index + direction, 0, rule);
    emit(next);
  };

  return (
    <div>
      <datalist id={refIdsListId}>
        {suggestions.refIds.map((refId) => (
          <option value={refId} key={refId} />
        ))}
      </datalist>
      <datalist id={labelsListId}>
        {labels.map((label) => (
          <option value={label} key={label} />
        ))}
      </datalist>
      <div style={{ marginBottom: 8, opacity: 0.8 }}>Available refIds: {suggestions.refIds.join(', ') || 'None'}</div>
      <div style={{ marginBottom: 12, opacity: 0.8 }}>Available labels: {labels.join(', ') || 'None'}</div>
      {rules.map((rule, ruleIndex) => {
        const matchers = normalizedMatchers(rule);
        const errors = validateRangeOverride(rule);
        const validationId = `range-override-validation-${instanceId}-${ruleIndex}`;
        const invalidMin = rule.min !== undefined && (typeof rule.min !== 'number' || !Number.isFinite(rule.min));
        const invalidMax = rule.max !== undefined && (typeof rule.max !== 'number' || !Number.isFinite(rule.max));
        const invalidOrder =
          typeof rule.min === 'number' &&
          Number.isFinite(rule.min) &&
          typeof rule.max === 'number' &&
          Number.isFinite(rule.max) &&
          rule.min >= rule.max;
        const invalidRefId = rule.refId !== undefined && typeof rule.refId !== 'string';
        const allMetrics = rule.refId === undefined || (typeof rule.refId === 'string' && rule.refId.trim() === '');
        return (
          <div
            key={ruleIndex}
            data-testid={`range-override-${ruleIndex}`}
            style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid rgba(128, 128, 128, 0.35)' }}
          >
            <InlineFieldRow>
              <InlineField label={`Override ${ruleIndex + 1}`}>
                <Input
                  aria-label="Metric refId"
                  aria-describedby={invalidRefId ? validationId : undefined}
                  aria-invalid={invalidRefId || undefined}
                  invalid={invalidRefId}
                  list={refIdsListId}
                  placeholder="All metrics"
                  value={typeof rule.refId === 'string' ? rule.refId : ''}
                  onChange={(event) => updateRule(ruleIndex, { refId: event.currentTarget.value || undefined })}
                  width={24}
                />
              </InlineField>
              {allMetrics && <span style={{ alignSelf: 'center', opacity: 0.8 }}>All metrics</span>}
              <IconButton
                name="arrow-up"
                aria-label="Move override up"
                tooltip="Move override up"
                disabled={ruleIndex === 0}
                onClick={() => moveRule(ruleIndex, -1)}
              />
              <IconButton
                name="arrow-down"
                aria-label="Move override down"
                tooltip="Move override down"
                disabled={ruleIndex === rules.length - 1}
                onClick={() => moveRule(ruleIndex, 1)}
              />
              <IconButton
                name="trash-alt"
                aria-label="Delete override"
                tooltip="Delete override"
                onClick={() => emit(rawRules.filter((_, index) => index !== ruleIndex))}
              />
            </InlineFieldRow>
            {matchers.map((matcher, matcherIndex) => {
              const valueListId = `range-override-values-${instanceId}-${ruleIndex}-${matcherIndex}`;
              const samples = suggestions.valuesByLabel[matcher.label] ?? [];
              const invalidRegex = hasInvalidRegex(matcher);
              return (
                <React.Fragment key={matcherIndex}>
                  <datalist id={valueListId}>
                    {samples.map((sample) => (
                      <option value={sample} key={sample} />
                    ))}
                  </datalist>
                  <InlineFieldRow>
                    <InlineField label={`Condition ${matcherIndex + 1}`}>
                      <Input
                        aria-label="Label name"
                        aria-describedby={errors.length > 0 ? validationId : undefined}
                        aria-invalid={!matcher.label.trim()}
                        invalid={!matcher.label.trim()}
                        list={labelsListId}
                        value={matcher.label}
                        onChange={(event) =>
                          updateMatcher(ruleIndex, matcherIndex, { label: event.currentTarget.value })
                        }
                        width={18}
                      />
                    </InlineField>
                    <InlineField label="Operator">
                      <RadioButtonGroup<RangeMatcherOperator>
                        aria-label="Operator"
                        options={OPERATOR_OPTIONS}
                        value={
                          matcher.operator === 'exact' || matcher.operator === 'regex' ? matcher.operator : undefined
                        }
                        invalid={matcher.operator !== 'exact' && matcher.operator !== 'regex'}
                        onChange={(operator) => updateMatcher(ruleIndex, matcherIndex, { operator })}
                      />
                    </InlineField>
                    <InlineField label="Value">
                      <Input
                        aria-label="Match value"
                        aria-describedby={invalidRegex ? validationId : undefined}
                        aria-invalid={invalidRegex || undefined}
                        invalid={invalidRegex}
                        list={valueListId}
                        value={matcher.value}
                        onChange={(event) =>
                          updateMatcher(ruleIndex, matcherIndex, { value: event.currentTarget.value })
                        }
                        width={22}
                      />
                    </InlineField>
                    <IconButton
                      name="trash-alt"
                      aria-label="Delete condition"
                      tooltip="Delete condition"
                      disabled={matchers.length <= 1}
                      onClick={() =>
                        updateRule(ruleIndex, {
                          matchers: (isRecord(rawRules[ruleIndex]) && Array.isArray(rawRules[ruleIndex].matchers)
                            ? rawRules[ruleIndex].matchers
                            : matchers
                          ).filter((_, index) => index !== matcherIndex),
                        })
                      }
                    />
                  </InlineFieldRow>
                  {samples.length > 0 && (
                    <div style={{ marginBottom: 8, opacity: 0.8 }}>Sample values: {samples.join(', ')}</div>
                  )}
                </React.Fragment>
              );
            })}
            <Button
              icon="plus"
              variant="secondary"
              size="sm"
              onClick={() =>
                updateRule(ruleIndex, {
                  matchers: [
                    ...(isRecord(rawRules[ruleIndex]) && Array.isArray(rawRules[ruleIndex].matchers)
                      ? rawRules[ruleIndex].matchers
                      : matchers),
                    { ...EMPTY_MATCHER },
                  ],
                })
              }
            >
              Add condition
            </Button>
            <InlineFieldRow>
              <InlineField label="Min">
                <Input
                  aria-label="Minimum"
                  aria-describedby={errors.length > 0 ? validationId : undefined}
                  aria-invalid={invalidMin || invalidOrder}
                  invalid={invalidMin || invalidOrder}
                  type="number"
                  value={inputValue(rule.min)}
                  onChange={(event) => updateRule(ruleIndex, { min: optionalNumber(event.currentTarget.value) })}
                  width={14}
                />
              </InlineField>
              <InlineField label="Max">
                <Input
                  aria-label="Maximum"
                  aria-describedby={errors.length > 0 ? validationId : undefined}
                  aria-invalid={invalidMax || invalidOrder}
                  invalid={invalidMax || invalidOrder}
                  type="number"
                  value={inputValue(rule.max)}
                  onChange={(event) => updateRule(ruleIndex, { max: optionalNumber(event.currentTarget.value) })}
                  width={14}
                />
              </InlineField>
            </InlineFieldRow>
            {errors.length > 0 && (
              <div id={validationId} role="alert">
                {errors.map((error) => (
                  <FieldValidationMessage key={error}>{error}</FieldValidationMessage>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <Button
        icon="plus"
        variant="secondary"
        onClick={() => emit([...rawRules, { matchers: [{ ...EMPTY_MATCHER }], max: undefined, min: undefined }])}
      >
        Add override
      </Button>
    </div>
  );
};
