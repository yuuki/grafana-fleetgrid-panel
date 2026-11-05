import { RangeMatcher, RangeOverride } from '../types';

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

// A persisted rule that cannot be applied: wrong refId type, no matchers, or a missing / non-finite / inverted range.
function isMalformedOverride(override: RangeOverride | undefined): boolean {
  return (
    !override ||
    (override.refId !== undefined && typeof override.refId !== 'string') ||
    !Array.isArray(override.matchers) ||
    override.matchers.length === 0 ||
    (override.min === undefined && override.max === undefined) ||
    !isFiniteEndpoint(override.min) ||
    !isFiniteEndpoint(override.max) ||
    (override.min !== undefined && override.max !== undefined && override.min >= override.max)
  );
}

function isMalformedMatcher(matcher: RangeMatcher | undefined): boolean {
  return (
    !matcher ||
    typeof matcher.label !== 'string' ||
    matcher.label.trim().length === 0 ||
    typeof matcher.value !== 'string' ||
    (matcher.operator !== 'exact' && matcher.operator !== 'regex')
  );
}

// Compiles a well-formed matcher; returns null when its regex does not compile.
function compileMatcher(matcher: RangeMatcher): CompiledMatcher | null {
  if (matcher.operator === 'exact') {
    return { label: matcher.label, matches: (value) => value === matcher.value };
  }
  try {
    const regex = new RegExp(matcher.value);
    return { label: matcher.label, matches: (value) => regex.test(value) };
  } catch {
    return null;
  }
}

// Compiles every matcher of a rule; returns null as soon as one is malformed or has an invalid regex.
function compileMatchers(matchers: RangeMatcher[]): CompiledMatcher[] | null {
  const compiled: CompiledMatcher[] = [];
  for (const matcher of matchers) {
    const result = isMalformedMatcher(matcher) ? null : compileMatcher(matcher);
    if (!result) {
      return null;
    }
    compiled.push(result);
  }
  return compiled;
}

export function compileRangeOverrides(overrides: RangeOverride[] | undefined): CompiledRangeOverride[] {
  const compiled: CompiledRangeOverride[] = [];
  if (!Array.isArray(overrides)) {
    return compiled;
  }
  for (const [index, override] of overrides.entries()) {
    if (isMalformedOverride(override)) {
      continue;
    }
    const matchers = compileMatchers(override.matchers);
    if (matchers) {
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
