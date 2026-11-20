/**
 * Hostlist notation, as Slurm and pdsh read it: `node-a[001-003,007],login1`.
 *
 * A bracket lists numbers and ranges for one numeric field of a name. Every number of a range is
 * printed at least as wide as the range's first number (`[08-11]` is 08, 09, 10, 11 and `[8-11]` is
 * 8, 9, 10, 11), so `node-a01` and `node-a1` are different names and never share a range.
 */

// A longer run of digits stays text: its value would not be exact as a JavaScript number.
const MAX_DIGITS = 15;
// The notation has no escape for its own punctuation, and a list item cannot be empty.
const UNSUPPORTED = /[,[\]]/;

const collator = new Intl.Collator('en', { numeric: true });

/** Natural order (`node-a2` before `node-a10`) that never calls two different strings equal. */
export function compareNatural(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Whether a name can be written in hostlist notation at all. */
export const isHostlistName = (name: string): boolean => name !== '' && !UNSUPPORTED.test(name);

interface ParsedName {
  /** The text around the numeric fields: texts[i] comes before digits[i], the last one after them all. */
  texts: string[];
  digits: string[];
}

function parseName(name: string): ParsedName {
  const texts = [''];
  const digits: string[] = [];
  const run = /\d+/g;
  let end = 0;
  for (let match = run.exec(name); match; match = run.exec(name)) {
    if (match[0].length > MAX_DIGITS) {
      continue;
    }
    texts[texts.length - 1] += name.slice(end, match.index);
    digits.push(match[0]);
    texts.push('');
    end = match.index + match[0].length;
  }
  texts[texts.length - 1] += name.slice(end);
  return { texts, digits };
}

// The field to put in brackets: the one with the most distinct values, and the last of those. In
// `node-a001.site2` that is the node number, and in `rack1-node03` (ties) the trailing number.
function varyingField(names: ParsedName[]): number {
  const fields = names[0].digits.length;
  let best = fields - 1;
  let bestCount = 0;
  for (let field = fields - 1; field >= 0; field--) {
    const count = new Set(names.map((name) => name.digits[field])).size;
    if (count > bestCount) {
      best = field;
      bestCount = count;
    }
  }
  return best;
}

// Runs of consecutive numbers, each number printed at least `width` digits wide.
function runs(values: number[], width: number): string[] {
  const print = (value: number) => String(value).padStart(width, '0');
  const sorted = [...values].sort((a, b) => a - b);
  const items: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) {
      j++;
    }
    items.push(i === j ? print(sorted[i]) : `${print(sorted[i])}-${print(sorted[j])}`);
    i = j + 1;
  }
  return items;
}

// The bracket items for the distinct digit strings of one field.
function rangeItems(strings: string[]): string[] {
  // A string with a leading zero has exactly one printed form: zero-padded to its own length.
  const padded = new Map<number, number[]>();
  const plain: string[] = [];
  for (const text of strings) {
    if (text.length > 1 && text.startsWith('0')) {
      const values = padded.get(text.length) ?? [];
      values.push(Number(text));
      padded.set(text.length, values);
    } else {
      plain.push(text);
    }
  }
  // A number without a leading zero prints the same at any width up to its own length. It joins the
  // widest zero-padded class it fits, so 001..099 and 100..120 become one range, [001-120].
  const widths = [...padded.keys()].sort((a, b) => b - a);
  const unpadded: number[] = [];
  for (const text of plain) {
    const width = widths.find((w) => w <= text.length);
    (width === undefined ? unpadded : padded.get(width)!).push(Number(text));
  }
  return [...runs(unpadded, 1), ...widths.reverse().flatMap((width) => runs(padded.get(width)!, width))];
}

/**
 * Compacts names into hostlist notation. The result expands to exactly the given set of names:
 * duplicates collapse, the order of the input does not matter, and a name without a number is listed
 * as it is. One numeric field per name is compacted; names that differ in another field or in their
 * text are listed separately.
 *
 * Returns `null` when a name is empty or contains `,`, `[` or `]`: the notation cannot express it.
 */
export function compactHostlist(names: Iterable<string>): string | null {
  const unique = [...new Set(names)].sort(compareNatural);
  if (!unique.every(isHostlistName)) {
    return null;
  }
  // Names with the same text around the same number of numeric fields form one family.
  const families = new Map<string, ParsedName[]>();
  for (const name of unique) {
    const parsed = parseName(name);
    const key = JSON.stringify(parsed.texts);
    const family = families.get(key) ?? [];
    family.push(parsed);
    families.set(key, family);
  }
  const pieces: string[] = [];
  for (const family of families.values()) {
    if (family[0].digits.length === 0) {
      pieces.push(family[0].texts[0]);
      continue;
    }
    const field = varyingField(family);
    // Within a family, names that agree on every other field share one bracket.
    const groups = new Map<string, { prefix: string; suffix: string; strings: string[] }>();
    for (const { texts, digits } of family) {
      let prefix = texts[0];
      for (let i = 0; i < field; i++) {
        prefix += digits[i] + texts[i + 1];
      }
      let suffix = texts[field + 1];
      for (let i = field + 1; i < digits.length; i++) {
        suffix += digits[i] + texts[i + 1];
      }
      const key = JSON.stringify([prefix, suffix]);
      const group = groups.get(key) ?? { prefix, suffix, strings: [] };
      group.strings.push(digits[field]);
      groups.set(key, group);
    }
    for (const { prefix, suffix, strings } of groups.values()) {
      const items = rangeItems(strings);
      const single = items.length === 1 && !items[0].includes('-');
      pieces.push(single ? `${prefix}${items[0]}${suffix}` : `${prefix}[${items.join(',')}]${suffix}`);
    }
  }
  return pieces.join(',');
}
