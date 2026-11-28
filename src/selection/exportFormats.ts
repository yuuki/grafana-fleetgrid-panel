import { CellModel, HierarchyNode, LevelDef } from '../types';
import { pathKey } from '../data/hierarchy';

/** The labels a selection can be exported by: the hierarchy levels' labels, top level first. */
export function selectionLabels(levels: LevelDef[]): string[] {
  return [...new Set(levels.map((level) => level.label).filter((label) => label !== ''))];
}

/**
 * The label a selection is copied by when the panel names none: the label of the deepest hierarchy
 * level whose values are unique in the grid, each value belonging to one group only. With zone → host
 * → gpu that is `host`: `gpu0` exists under every host and says nothing without it, while a host name
 * identifies its group. The top level always qualifies: each of its values is its own group.
 *
 * The answer depends on the data that is on screen (one host alone makes `gpu` unique), so the panel
 * asks once, when a selection begins, and keeps the answer for the life of that selection. The
 * variable sync does not use it at all: what other panels are filtered by is named in the options.
 */
export function defaultSelectionLabel(root: HierarchyNode, levels: LevelDef[]): string | undefined {
  const cells: CellModel[] = [];
  const visit = (node: HierarchyNode) => {
    if (node.cell) {
      cells.push(node.cell);
    }
    node.children.forEach(visit);
  };
  visit(root);
  for (let depth = levels.length - 1; depth >= 0; depth--) {
    const label = levels[depth].label;
    if (label === '') {
      continue;
    }
    const groupByValue = new Map<string, string>();
    const unique = cells.every((cell) => {
      const group = pathKey(cell.path.slice(0, depth + 1));
      return (cell.labelSets ?? [cell.labels]).every((labels) => {
        const value = labels[label];
        if (value === undefined) {
          return true;
        }
        const seen = groupByValue.get(value);
        groupByValue.set(value, group);
        return seen === undefined || seen === group;
      });
    });
    if (unique) {
      return label;
    }
  }
  // No level has a label.
  return undefined;
}

/**
 * The configured selection label when it names a hierarchy level, undefined otherwise. Cells keep
 * only the labels of the hierarchy levels, so no other label can be exported.
 */
export function configuredSelectionLabel(configured: string | undefined, levels: LevelDef[]): string | undefined {
  const name = configured?.trim();
  return name && selectionLabels(levels).includes(name) ? name : undefined;
}

const REGEX_SPECIAL = /[\\^[\].*+?()|{}$]/g;

/**
 * A regular expression that matches the value literally. A metacharacter is written as a
 * one-character class (`.` becomes `[.]`): a class needs no backslash, so the result can be pasted
 * into a double-quoted PromQL or LogQL string, where `\.` is an invalid escape sequence and the
 * expression would need `\\.`. Only the four characters that are special inside a class as well
 * (backslash, `^`, `[` and `]`) take a backslash.
 */
export function escapeRegexValue(value: string): string {
  return value.replace(REGEX_SPECIAL, (char) => ('\\^[]'.includes(char) ? `\\${char}` : `[${char}]`));
}

/**
 * A regular expression that matches exactly the given values: `^(node-a1|node-a2)$`. The anchors make
 * it exact where a match is a search (grep, JavaScript, LogQL line filters) and are redundant but
 * harmless where it is already anchored (PromQL and LogQL label matchers). The group is a plain one,
 * which every dialect reads. Empty when there are no values.
 */
export function toRegex(values: string[]): string {
  return values.length === 0 ? '' : `^(${values.map(escapeRegexValue).join('|')})$`;
}

/**
 * The values separated by commas. A value that contains a comma, a double quote, a line break or
 * outer white space is quoted as in CSV (RFC 4180); host names never need it.
 */
export function toList(values: string[]): string {
  return values.map((value) => (/[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(',');
}
