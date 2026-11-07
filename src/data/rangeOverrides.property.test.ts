import fc from 'fast-check';
import { RangeOverride } from '../types';
import { compileRangeOverrides, resolveCellRangeOverride, resolveRangeOverride } from './rangeOverrides';
import { propertyParams } from '../testing/property';

// rangeOverrides come from saved dashboard JSON, so compileRangeOverrides must accept anything,
// and the design contract (docs/design.md §5) is that an aggregated cell never picks a range
// according to the order of its source label sets.

const labelName = fc.constantFrom('zone', 'pod', 'bw_type');
const labelValue = fc.constantFrom('zone-a', 'zone-b', 'pod-1', 'NVLink 0', 'PCIe 1', '');

const matcher = fc.oneof(
  fc.record({ label: labelName, operator: fc.constant<'exact'>('exact'), value: labelValue }),
  fc.record({ label: labelName, operator: fc.constant<'regex'>('regex'), value: fc.constantFrom('^zone-', 'a$', '^(NVLink|PCIe) ', '(') })
);

const override: fc.Arbitrary<RangeOverride> = fc.record(
  {
    refId: fc.constantFrom('', ' ', 'A', 'B'),
    matchers: fc.array(matcher, { maxLength: 3 }),
    min: fc.oneof(fc.integer({ min: -10, max: 10 }), fc.constant(Number.NaN)),
    max: fc.integer({ min: -10, max: 1000 }),
  },
  { requiredKeys: ['matchers'] }
);

const sourceLabels = fc.dictionary(labelName, labelValue, { maxKeys: 3 });

describe('range overrides (properties)', () => {
  it('compiles only applicable rules from arbitrary persisted JSON without throwing', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(override, fc.anything()), { maxLength: 6 }), (persisted) => {
        const rules = compileRangeOverrides(persisted as RangeOverride[]);
        let previous = -1;
        for (const rule of rules) {
          // Rules keep their persisted position (the identity used for conflict detection) and order.
          expect(rule.index).toBeGreaterThan(previous);
          previous = rule.index;
          expect(rule.override).toBe(persisted[rule.index]);
          expect(rule.matchers.length).toBeGreaterThan(0);
          const { min, max } = rule.override;
          expect(min !== undefined || max !== undefined).toBe(true);
          if (min !== undefined && max !== undefined) {
            expect(min).toBeLessThan(max);
          }
        }
      }),
      propertyParams()
    );
  });

  it('resolves an aggregated cell independently of the order of its source label sets', () => {
    fc.assert(
      fc.property(
        fc.array(override, { maxLength: 5 }),
        fc.constantFrom('A', 'B'),
        fc.array(sourceLabels, { maxLength: 5 }),
        fc.infiniteStream(fc.nat()),
        (overrides, refId, sets, picks) => {
          const rules = compileRangeOverrides(overrides);
          const shuffled = [...sets];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = picks.next().value % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }

          const resolution = resolveCellRangeOverride(rules, refId, sets);
          const reordered = resolveCellRangeOverride(rules, refId, shuffled);
          const identity = (r: typeof resolution) => (r.status === 'matched' ? r.rule.index : r.status);
          expect(identity(reordered)).toEqual(identity(resolution));

          const perSet = new Set(sets.map((labels) => resolveRangeOverride(rules, refId, labels)?.index));
          if (resolution.status === 'matched') {
            expect([...perSet]).toEqual([resolution.rule.index]);
          } else if (resolution.status === 'conflict') {
            expect(perSet.size).toBeGreaterThan(1);
          } else {
            expect(sets.length === 0 || (perSet.size === 1 && perSet.has(undefined))).toBe(true);
          }
        }
      ),
      propertyParams()
    );
  });
});
