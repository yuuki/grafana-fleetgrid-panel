// Test-only helper: the inverse of compactHostlist (src/selection/hostlist.ts). Nothing in the plugin
// bundle imports it: webpack only follows imports from src/module.ts.
//
// It is written from the notation's rules, not from the compactor, so the round-trip property
// `expandHostlist(compactHostlist(names))` checks the compactor against an independent reading:
//
//   list   = item { "," item }          commas inside brackets do not split
//   item   = text { "[" ranges "]" text }
//   ranges = range { "," range }
//   range  = number | number "-" number
//
// A range lists every integer from its first to its last number, each printed at least as wide as
// the first number was written: [08-11] is 08, 09, 10, 11 and [8-11] is 8, 9, 10, 11.

function splitTopLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth < 0) {
        throw new Error(`unbalanced "]" in hostlist: ${text}`);
      }
    } else if (char === ',' && depth === 0) {
      items.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) {
    throw new Error(`unbalanced "[" in hostlist: ${text}`);
  }
  items.push(text.slice(start));
  return items;
}

function expandRange(range: string): string[] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(range);
  if (!match) {
    throw new Error(`invalid range in hostlist: ${range}`);
  }
  const width = match[1].length;
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || high < low) {
    throw new Error(`invalid range in hostlist: ${range}`);
  }
  const numbers: string[] = [];
  for (let value = low; value <= high; value++) {
    numbers.push(String(value).padStart(width, '0'));
  }
  return numbers;
}

function expandItem(item: string): string[] {
  const open = item.indexOf('[');
  if (open < 0) {
    if (item.includes(']')) {
      throw new Error(`unbalanced "]" in hostlist: ${item}`);
    }
    return [item];
  }
  const close = item.indexOf(']', open);
  const prefix = item.slice(0, open);
  const numbers = item
    .slice(open + 1, close)
    .split(',')
    .flatMap(expandRange);
  const rest = expandItem(item.slice(close + 1));
  return numbers.flatMap((number) => rest.map((suffix) => `${prefix}${number}${suffix}`));
}

/** The names a hostlist stands for, in the order it lists them. The empty hostlist is no names. */
export function expandHostlist(hostlist: string): string[] {
  return hostlist === '' ? [] : splitTopLevel(hostlist).flatMap(expandItem);
}
