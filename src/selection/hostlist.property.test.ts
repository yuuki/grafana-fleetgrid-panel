import fc from 'fast-check';
import { compactHostlist, isHostlistName } from './hostlist';
import { expandHostlist } from '../testing/hostlist';
import { propertyParams } from '../testing/property';

// compactHostlist rewrites the selected names; an operator pastes the result into a scheduler
// command. The property that matters is that it stands for exactly the names that went in: nothing
// lost, nothing added, nothing twice. It is checked against the independent expander in
// src/testing/hostlist.ts on names built to hit the sharp edges (zero padding at several widths, the
// same number at two widths, several numeric fields, numbers at the 10^n boundaries, digit runs too
// long to be exact numbers) and on arbitrary text.

const text = fc.constantFrom('node-', 'node-a', 'node-b', 'rack', 'gpu', 'n', '-', '.', 'Node-', '');
const digits = fc.oneof(
  // Small numbers, so that runs form, written at their natural width or zero-padded to 1..4 digits.
  fc
    .tuple(fc.integer({ min: 0, max: 24 }), fc.integer({ min: 1, max: 4 }))
    .map(([n, width]) => String(n).padStart(width, '0')),
  // The boundaries where the natural width changes.
  fc.constantFrom('8', '9', '10', '11', '98', '99', '100', '101', '0998', '0999', '1000', '1001', '0', '00'),
  // Up to and beyond the 15 digits that are kept as a number.
  fc.stringMatching(/^[0-9]{13,18}$/)
);
const hostName = fc
  .array(fc.tuple(text, digits), { minLength: 1, maxLength: 3 })
  .chain((fields) => text.map((tail) => fields.map(([t, d]) => t + d).join('') + tail));
// Any text the notation can carry: no comma, no bracket, no white space, not empty.
const anyName = fc.string({ minLength: 1, maxLength: 12 }).filter(isHostlistName);
const names = fc.array(fc.oneof({ weight: 4, arbitrary: hostName }, { weight: 1, arbitrary: anyName }), {
  maxLength: 60,
});

describe('compactHostlist (properties)', () => {
  it('expands back to exactly the set of names it was given', () => {
    fc.assert(
      fc.property(names, (input) => {
        const hostlist = compactHostlist(input);
        expect(hostlist).not.toBeNull();
        const expanded = expandHostlist(hostlist!);
        const unique = new Set(input);
        // No name twice, and the same set.
        expect(expanded).toHaveLength(unique.size);
        expect(new Set(expanded)).toEqual(unique);
      }),
      propertyParams()
    );
  });

  it('does not depend on the order or the multiplicity of its input', () => {
    fc.assert(
      fc.property(
        names.chain((input) =>
          fc.record({
            input: fc.constant(input),
            shuffled: fc.shuffledSubarray([...input, ...input], { minLength: input.length * 2 }),
          })
        ),
        ({ input, shuffled }) => {
          expect(compactHostlist(shuffled)).toBe(compactHostlist(input));
        }
      ),
      propertyParams()
    );
  });

  it('never lists more items than names, and refuses exactly the names the notation cannot carry', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(hostName, fc.string({ maxLength: 6 })), { maxLength: 30 }), (input) => {
        const hostlist = compactHostlist(input);
        if (!input.every(isHostlistName)) {
          expect(hostlist).toBeNull();
          return;
        }
        expect(hostlist).not.toBeNull();
        // White space would split the list where Slurm, pdsh or a shell reads it.
        expect(hostlist).not.toMatch(/\s/);
        // A bracket never holds a comma-separated top-level item, so counting top-level commas counts items.
        const items = hostlist === '' ? 0 : hostlist!.replace(/\[[^\]]*\]/g, '').split(',').length;
        expect(items).toBeLessThanOrEqual(new Set(input).size);
      }),
      propertyParams()
    );
  });
});
