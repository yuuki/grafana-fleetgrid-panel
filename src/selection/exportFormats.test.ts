import { CellModel, DEFAULT_LEVEL, HierarchyNode, LevelDef, NormalizedRow } from '../types';
import { buildHierarchy } from '../data/hierarchy';
import { attachCells } from '../data/values';
import { indexCells } from './selection';
import {
  defaultSelectionLabel,
  escapeRegexValue,
  labelValues,
  resolveSelectionLabel,
  selectionLabels,
  toList,
  toRegex,
} from './exportFormats';

const level = (label: string, over: Partial<LevelDef> = {}): LevelDef => ({ ...DEFAULT_LEVEL, label, ...over });

function build(levels: LevelDef[], labelSets: Array<Record<string, string>>): { root: HierarchyNode; cells: CellModel[] } {
  const rows: NormalizedRow[] = labelSets.map((labels) => ({ labels, value: 1, refId: 'A' }));
  const { root } = buildHierarchy(rows, levels);
  attachCells(root, rows, levels, 'max');
  return { root, cells: [...indexCells(root).values()] };
}

const gpuRows = [
  { zone: 'zone-a', host: 'node-a001', gpu: 'gpu0' },
  { zone: 'zone-a', host: 'node-a001', gpu: 'gpu1' },
  { zone: 'zone-a', host: 'node-a002', gpu: 'gpu0' },
  { zone: 'zone-b', host: 'node-b001', gpu: 'gpu0' },
];

describe('selection label', () => {
  it('offers the hierarchy labels, top level first, each once', () => {
    expect(selectionLabels([level('zone'), level('host'), level(''), level('host')])).toEqual(['zone', 'host']);
  });

  it('defaults to the deepest level whose values are unique in the grid', () => {
    const levels = [level('zone'), level('host'), level('gpu')];
    // gpu0 exists under several hosts; a host name identifies its group.
    expect(defaultSelectionLabel(build(levels, gpuRows).root, levels)).toBe('host');
    const hostLevels = [level('zone'), level('host')];
    expect(defaultSelectionLabel(build(hostLevels, gpuRows).root, hostLevels)).toBe('host');
    const flat = [level('host')];
    expect(defaultSelectionLabel(build(flat, gpuRows).root, flat)).toBe('host');
  });

  it('judges uniqueness on the label values, not on the extracted keys', () => {
    // Trailing numbers repeat across zones (001 under zone-a and zone-b), the host names do not.
    const levels = [level('zone'), level('host', { extract: 'trailingNumber' }), level('gpu')];
    expect(defaultSelectionLabel(build(levels, gpuRows).root, levels)).toBe('host');
  });

  it('goes up to the top level, whose values are always unique, and has no answer without a labelled level', () => {
    // zone-a exists under gpu0 and under gpu1.
    const levels = [level('gpu'), level('zone')];
    const rows = [
      { zone: 'zone-a', gpu: 'gpu0' },
      { zone: 'zone-b', gpu: 'gpu0' },
      { zone: 'zone-a', gpu: 'gpu1' },
    ];
    expect(defaultSelectionLabel(build(levels, rows).root, levels)).toBe('gpu');
    expect(defaultSelectionLabel({ key: '', path: [], children: [] }, [])).toBeUndefined();
    expect(defaultSelectionLabel({ key: '', path: [], children: [] }, [level('')])).toBeUndefined();
  });

  it('uses the configured label when it is a hierarchy label, the default otherwise', () => {
    const levels = [level('zone'), level('host'), level('gpu')];
    const { root } = build(levels, gpuRows);
    expect(resolveSelectionLabel('zone', root, levels)).toBe('zone');
    expect(resolveSelectionLabel(' gpu ', root, levels)).toBe('gpu');
    expect(resolveSelectionLabel('', root, levels)).toBe('host');
    expect(resolveSelectionLabel(undefined, root, levels)).toBe('host');
    // Cells do not keep a label that is not a hierarchy level.
    expect(resolveSelectionLabel('partition', root, levels)).toBe('host');
  });
});

describe('labelValues', () => {
  it('lists the distinct values of the cells in natural order', () => {
    const levels = [level('zone'), level('host'), level('gpu')];
    const { cells } = build(levels, [
      { zone: 'zone-a', host: 'node-a10', gpu: 'gpu0' },
      { zone: 'zone-a', host: 'node-a2', gpu: 'gpu0' },
      { zone: 'zone-a', host: 'node-a2', gpu: 'gpu1' },
    ]);
    expect(labelValues(cells, 'host')).toEqual(['node-a2', 'node-a10']);
    expect(labelValues(cells, 'gpu')).toEqual(['gpu0', 'gpu1']);
    expect(labelValues(cells, 'partition')).toEqual([]);
    expect(labelValues([], 'host')).toEqual([]);
  });

  it('includes every source value of a cell that merges several series', () => {
    const levels = [level('host', { extract: 'trailingNumber' })];
    const { cells } = build(levels, [{ host: 'node-a017' }, { host: 'node-b017' }]);
    expect(cells).toHaveLength(1);
    expect(labelValues(cells, 'host')).toEqual(['node-a017', 'node-b017']);
  });

  it('reads the representative labels of a cell that has no label sets', () => {
    expect(labelValues([{ path: ['x'], labels: { host: 'node-a1' }, values: new Map() }], 'host')).toEqual(['node-a1']);
  });
});

describe('toRegex', () => {
  it('anchors a plain group of alternatives', () => {
    expect(toRegex(['node-a001', 'node-a002'])).toBe('^(node-a001|node-a002)$');
    expect(toRegex(['node-a001'])).toBe('^(node-a001)$');
    expect(toRegex([])).toBe('');
  });

  it('escapes metacharacters without a backslash, so the text is valid inside a PromQL string', () => {
    expect(escapeRegexValue('node-a001.example.com')).toBe('node-a001[.]example[.]com');
    expect(escapeRegexValue('a+b*c?(d)|{e}$')).toBe('a[+]b[*]c[?][(]d[)][|][{]e[}][$]');
    expect(toRegex(['node-a001.example.com'])).not.toContain('\\');
  });

  it('escapes the characters that are special inside a class with a backslash', () => {
    expect(escapeRegexValue('a\\b^c[d]')).toBe('a\\\\b\\^c\\[d\\]');
  });

  it.each([
    ['node-a001.example.com', 'node-a001xexample.com'],
    ['a+b', 'aab'],
    ['a|b', 'a'],
    ['(x)', 'x'],
    ['a\\d', 'a1'],
    ['^a$', 'a'],
    ['[ab]', 'a'],
    ['x{2}', 'xx'],
    ['a?', ''],
    ['', 'a'],
  ])('matches %j literally and not %j', (value, other) => {
    const regex = new RegExp(toRegex([value]));
    expect(regex.test(value)).toBe(true);
    expect(regex.test(other)).toBe(false);
  });

  it('matches whole values only', () => {
    const regex = new RegExp(toRegex(['node-a1', 'node-a2']));
    expect(regex.test('node-a1')).toBe(true);
    expect(regex.test('node-a2')).toBe(true);
    expect(regex.test('node-a10')).toBe(false);
    expect(regex.test('xnode-a1')).toBe(false);
  });
});

describe('toList', () => {
  it('joins values with commas', () => {
    expect(toList(['node-a001', 'node-a002'])).toBe('node-a001,node-a002');
    expect(toList([])).toBe('');
  });

  it('quotes a value that would break the list, as CSV does', () => {
    expect(toList(['a,b', 'say "hi"', ' padded', 'line\nbreak', 'plain'])).toBe(
      '"a,b","say ""hi""",\" padded\","line\nbreak",plain'
    );
  });
});
