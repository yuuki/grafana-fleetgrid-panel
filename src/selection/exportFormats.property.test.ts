import fc from 'fast-check';
import { needsQuoteEscaping, toList, toRegex } from './exportFormats';
import { propertyParams } from '../testing/property';

// The copied regular expression must select exactly the selected values, whatever characters they
// contain: a metacharacter that slips through unescaped would either break the expression or match
// hosts that were not selected.

// Label values made mostly of the characters that mean something in a regular expression.
const special = fc.constantFrom(...'.*+?()[]{}|^$\\-/ab01"\n\r\t'.split(''));
const value = fc.oneof(
  fc.array(special, { maxLength: 8 }).map((chars) => chars.join('')),
  fc.string({ maxLength: 8 }),
  fc.constantFrom('node-a001', 'node-a001.example.com', 'node-a002')
);

describe('toRegex (properties)', () => {
  it('compiles, matches every value and matches no other string', () => {
    fc.assert(
      fc.property(
        fc.array(value, { minLength: 1, maxLength: 8 }),
        fc.array(value, { maxLength: 8 }),
        (values, others) => {
          const regex = new RegExp(toRegex(values));
          for (const v of values) {
            expect(regex.test(v)).toBe(true);
          }
          // Other strings, and near misses of the values themselves.
          const candidates = [...others, ...values.flatMap((v) => [`${v}x`, `x${v}`, v.slice(1), v.slice(0, -1)])];
          for (const candidate of candidates) {
            expect(regex.test(candidate)).toBe(values.includes(candidate));
          }
        }
      ),
      propertyParams()
    );
  });

  // The promise of the README: unless the bar warns, the copied text can stand between the double
  // quotes of a PromQL or LogQL matcher as it is.
  it('has no backslash, quote or line break that a quoted string would read differently', () => {
    fc.assert(
      fc.property(fc.array(value, { minLength: 1, maxLength: 8 }), (values) => {
        fc.pre(!values.some(needsQuoteEscaping));
        const text = toRegex(values);
        // The only backslashes are those of \n and \r, which the string turns into the line break
        // that the expression then matches literally.
        expect(text.replace(/\\[nr]/g, '')).not.toMatch(/[\\"\n\r]/);
        const regex = new RegExp(text.replace(/\\n/g, '\n').replace(/\\r/g, '\r'));
        for (const v of values) {
          expect(regex.test(v)).toBe(true);
          expect(regex.test(`${v}x`)).toBe(values.includes(`${v}x`));
        }
      }),
      propertyParams()
    );
  });
});

// A reader that follows RFC 4180: fields separated by commas, a field in double quotes may contain
// commas, line breaks and doubled quotes.
function parseList(text: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

describe('toList (properties)', () => {
  it('reads back as the same values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('a,b', '"', 'x"y', ' a', 'node-a1')), {
          minLength: 1,
          maxLength: 8,
        }),
        (values) => {
          expect(parseList(toList(values))).toEqual(values);
        }
      ),
      propertyParams()
    );
  });
});
