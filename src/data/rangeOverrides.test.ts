import { RangeOverride } from '../types';
import { compileRangeOverrides, resolveCellRangeOverride, resolveRangeOverride } from './rangeOverrides';

const overrides: RangeOverride[] = [
  {
    refId: 'A',
    matchers: [
      { label: 'zone', operator: 'exact', value: 'zone-a' },
      { label: 'bw_type', operator: 'regex', value: '^NVLink ' },
    ],
    min: 0,
    max: 700,
  },
  { matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }], max: 900 },
];

describe('range overrides', () => {
  it('matches refId, exact and regex conditions using AND semantics', () => {
    const rules = compileRangeOverrides(overrides);
    expect(resolveRangeOverride(rules, 'A', { zone: 'zone-a', bw_type: 'NVLink RX' })?.index).toBe(0);
    expect(resolveRangeOverride(rules, 'B', { zone: 'zone-a', bw_type: 'NVLink RX' })?.index).toBe(1);
    expect(resolveRangeOverride(rules, 'A', { zone: 'zone-a', bw_type: 'PCIe RX' })?.index).toBe(1);
    expect(resolveRangeOverride(rules, 'A', { zone: 'zone-b', bw_type: 'NVLink RX' })).toBeUndefined();
  });

  it('uses the first matching rule in UI order', () => {
    const rules = compileRangeOverrides([
      { matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }], max: 100 },
      { matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }], max: 200 },
    ]);
    expect(resolveRangeOverride(rules, 'A', { zone: 'zone-a' })?.override.max).toBe(100);
  });

  it('ignores invalid rules instead of throwing', () => {
    const rules = compileRangeOverrides([
      { matchers: [], max: 1 },
      { matchers: [{ label: '', operator: 'exact', value: 'x' }], max: 1 },
      { matchers: [{ label: 'zone', operator: 'regex', value: '[' }], max: 1 },
      { matchers: [{ label: 'zone', operator: 'exact', value: 'x' }] },
      { matchers: [{ label: 'zone', operator: 'exact', value: 'x' }], min: Number.NaN },
      { matchers: [{ label: 'zone', operator: 'exact', value: 'x' }], min: 2, max: 1 },
      { matchers: [{ label: 'zone', operator: 'exact', value: 'ok' }], min: 0 },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].index).toBe(6);
  });

  it('ignores a persisted malformed rule whose matchers property is missing', () => {
    const malformed = { max: 100 } as unknown as RangeOverride;
    expect(() => compileRangeOverrides([malformed])).not.toThrow();
    expect(compileRangeOverrides([malformed])).toEqual([]);
  });

  it('ignores persisted malformed matcher entries and missing values', () => {
    const nullMatcher = { matchers: [null], max: 100 } as unknown as RangeOverride;
    const missingValue = {
      matchers: [{ label: 'zone', operator: 'exact' }],
      max: 100,
    } as unknown as RangeOverride;
    expect(() => compileRangeOverrides([nullMatcher, missingValue])).not.toThrow();
    expect(compileRangeOverrides([nullMatcher, missingValue])).toEqual([]);
  });

  it.each([42, null, { query: 'A' }])('ignores a rule with a defined non-string refId: %p', (refId) => {
    const malformed = {
      refId,
      matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }],
      max: 100,
    } as unknown as RangeOverride;

    expect(compileRangeOverrides([malformed])).toEqual([]);
  });

  it('treats an empty or whitespace-only refId as all metrics without trimming non-empty refIds', () => {
    const rules = compileRangeOverrides([
      { refId: '   ', matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }], max: 100 },
      { refId: ' A ', matchers: [{ label: 'zone', operator: 'exact', value: 'zone-b' }], max: 200 },
    ]);

    expect(resolveRangeOverride(rules, 'B', { zone: 'zone-a' })?.index).toBe(0);
    expect(resolveRangeOverride(rules, 'A', { zone: 'zone-b' })).toBeUndefined();
    expect(resolveRangeOverride(rules, ' A ', { zone: 'zone-b' })?.index).toBe(1);
  });

  it('ignores a matcher whose label is whitespace-only', () => {
    const malformed = {
      matchers: [{ label: '   ', operator: 'exact', value: 'zone-a' }],
      max: 100,
    } as RangeOverride;

    expect(compileRangeOverrides([malformed])).toEqual([]);
  });

  it('ignores a persisted null rule', () => {
    const overrides = [null] as unknown as RangeOverride[];
    expect(() => compileRangeOverrides(overrides)).not.toThrow();
    expect(compileRangeOverrides(overrides)).toEqual([]);
  });

  it.each([{}, 'not-an-array', 42])('ignores a persisted non-array container: %p', (persisted) => {
    const overrides = persisted as unknown as RangeOverride[];
    expect(() => compileRangeOverrides(overrides)).not.toThrow();
    expect(compileRangeOverrides(overrides)).toEqual([]);
  });

  it('matches only own string label properties', () => {
    const inherited = Object.create({ zone: 'zone-a' }) as Record<string, string>;
    const exact = compileRangeOverrides([
      { matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }], max: 100 },
    ]);
    const prototypeName = compileRangeOverrides([
      { matchers: [{ label: 'toString', operator: 'regex', value: 'native code' }], max: 100 },
    ]);
    expect(resolveRangeOverride(exact, 'A', inherited)).toBeUndefined();
    expect(resolveRangeOverride(prototypeName, 'A', {})).toBeUndefined();
  });

  it('treats different rule identities and matched/unmatched mixtures as conflicts independent of label order', () => {
    const rules = compileRangeOverrides([
      { matchers: [{ label: 'zone', operator: 'exact', value: 'a' }], max: 100 },
      { matchers: [{ label: 'zone', operator: 'exact', value: 'b' }], max: 100 },
    ]);
    const a = { zone: 'a' };
    const b = { zone: 'b' };
    const none = { zone: 'c' };
    expect(resolveCellRangeOverride(rules, 'A', [a, a])).toMatchObject({ status: 'matched', rule: { index: 0 } });
    expect(resolveCellRangeOverride(rules, 'A', [a, b]).status).toBe('conflict');
    expect(resolveCellRangeOverride(rules, 'A', [b, a]).status).toBe('conflict');
    expect(resolveCellRangeOverride(rules, 'A', [a, none]).status).toBe('conflict');
    expect(resolveCellRangeOverride(rules, 'A', [none, none]).status).toBe('unmatched');
  });
});
