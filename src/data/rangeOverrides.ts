import { RangeOverride } from '../types';

interface CompiledMatcher {
  label: string;
  matches: (value: string) => boolean;
}

export interface CompiledRangeOverride {
  /** Original array position, used as the rule identity when detecting aggregation conflicts. */
  index: number;
  override: RangeOverride;
  matchers: CompiledMatcher[];
}

export type CellRangeOverrideResolution =
  { status: 'unmatched' } | { status: 'matched'; rule: CompiledRangeOverride } | { status: 'conflict' };

const isFiniteEndpoint = (value: number | undefined): boolean => value === undefined || Number.isFinite(value);

export function compileRangeOverrides(overrides: RangeOverride[] | undefined): CompiledRangeOverride[] {
  const compiled: CompiledRangeOverride[] = [];
  if (!Array.isArray(overrides)) {
    return compiled;
  }
  for (const [index, override] of overrides.entries()) {
    if (
      !override ||
      (override.refId !== undefined && typeof override.refId !== 'string') ||
      !Array.isArray(override.matchers) ||
      override.matchers.length === 0 ||
      (override.min === undefined && override.max === undefined) ||
      !isFiniteEndpoint(override.min) ||
      !isFiniteEndpoint(override.max) ||
      (override.min !== undefined && override.max !== undefined && override.min >= override.max)
    ) {
      continue;
    }

    const matchers: CompiledMatcher[] = [];
    let valid = true;
    for (const matcher of override.matchers) {
      if (
        !matcher ||
        typeof matcher.label !== 'string' ||
        matcher.label.trim().length === 0 ||
        typeof matcher.value !== 'string' ||
        (matcher.operator !== 'exact' && matcher.operator !== 'regex')
      ) {
        valid = false;
        break;
      }
      if (matcher.operator === 'exact') {
        matchers.push({ label: matcher.label, matches: (value) => value === matcher.value });
        continue;
      }
      try {
        const regex = new RegExp(matcher.value);
        matchers.push({ label: matcher.label, matches: (value) => regex.test(value) });
      } catch {
        valid = false;
        break;
      }
    }
    if (valid) {
      compiled.push({ index, override, matchers });
    }
  }
  return compiled;
}

export function resolveRangeOverride(
  rules: CompiledRangeOverride[],
  refId: string,
  labels: Record<string, string>
): CompiledRangeOverride | undefined {
  return rules.find(
    (rule) =>
      (rule.override.refId === undefined || rule.override.refId.trim() === '' || rule.override.refId === refId) &&
      rule.matchers.every((matcher) => {
        if (!Object.prototype.hasOwnProperty.call(labels, matcher.label)) {
          return false;
        }
        const value = labels[matcher.label];
        return typeof value === 'string' && matcher.matches(value);
      })
  );
}

export function resolveCellRangeOverride(
  rules: CompiledRangeOverride[],
  refId: string,
  sourceLabelSets: Array<Record<string, string>>
): CellRangeOverrideResolution {
  if (sourceLabelSets.length === 0) {
    return { status: 'unmatched' };
  }
  const identities = new Set<number | undefined>();
  let matchedRule: CompiledRangeOverride | undefined;
  for (const labels of sourceLabelSets) {
    const rule = resolveRangeOverride(rules, refId, labels);
    identities.add(rule?.index);
    matchedRule = matchedRule ?? rule;
  }
  if (identities.size > 1) {
    return { status: 'conflict' };
  }
  return matchedRule ? { status: 'matched', rule: matchedRule } : { status: 'unmatched' };
}
