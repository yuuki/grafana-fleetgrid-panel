import { DEFAULT_LEVEL, HierarchyNode, LevelDef, NormalizedRow } from '../types';
import { buildHierarchy } from '../data/hierarchy';
import { attachCells } from '../data/values';
import {
  configuredSelectionLabel,
  defaultSelectionLabel,
  escapeRegexValue,
  needsQuoteEscaping,
  selectionLabels,
  toList,
  toRegex,
} from './exportFormats';

const level = (label: string, over: Partial<LevelDef> = {}): LevelDef => ({ ...DEFAULT_LEVEL, label, ...over });

function build(levels: LevelDef[], labelSets: Array<Record<string, string>>): { root: HierarchyNode } {
  const rows: NormalizedRow[] = labelSets.map((labels) => ({ labels, value: 1, refId: 'A' }));
  const { root } = buildHierarchy(rows, levels);
  attachCells(root, rows, levels, 'max');
  return { root };
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

  it('depends on the data on screen: one host alone makes gpu unique, and a host name in two zones makes zone the answer', () => {
    // This is why the panel asks once per selection and never for the variable sync.
    const levels = [level('zone'), level('host'), level('gpu')];
    const oneHost = gpuRows.filter((row) => row.host === 'node-a001');
    expect(defaultSelectionLabel(build(levels, oneHost).root, levels)).toBe('gpu');
    const sameNameTwice = [...gpuRows, { zone: 'zone-b', host: 'node-a001', gpu: 'gpu0' }];
    expect(defaultSelectionLabel(build(levels, sameNameTwice).root, levels)).toBe('zone');
  });

  it('takes a configured label only when it names a hierarchy level', () => {
    const levels = [level('zone'), level('host'), level('gpu')];
    expect(configuredSelectionLabel('zone', levels)).toBe('zone');
    expect(configuredSelectionLabel(' gpu ', levels)).toBe('gpu');
    expect(configuredSelectionLabel('', levels)).toBeUndefined();
    expect(configuredSelectionLabel(undefined, levels)).toBeUndefined();
    // Cells do not keep a label that is not a hierarchy level.
    expect(configuredSelectionLabel('partition', levels)).toBeUndefined();
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

  it('writes brackets without a backslash too', () => {
    // An IPv6 address with a port, as the instance label of a Prometheus target has it.
    expect(escapeRegexValue('[fd00::1]:9100')).toBe('[[]fd00::1]:9100');
    expect(escapeRegexValue('a[b]')).toBe('a[[]b]');
    expect(escapeRegexValue('[[x]]')).toBe('[[][[]x]]');
  });

  it('writes a line break as an escape sequence that a quoted string and the expression read alike', () => {
    expect(escapeRegexValue('a\nb\rc')).toBe('a\\nb\\rc');
    expect(toRegex(['a\nb'])).not.toContain('\n');
  });

  it('escapes a backslash and ^ with a backslash: they have no other form', () => {
    expect(escapeRegexValue('a\\b^c')).toBe('a\\\\b\\^c');
  });

  it.each([
    ['node-a001.example.com', 'node-a001xexample.com'],
    ['a+b', 'aab'],
    ['a|b', 'a'],
    ['(x)', 'x'],
    ['a\\d', 'a1'],
    ['^a$', 'a'],
    ['[ab]', 'a'],
    ['[fd00::1]:9100', 'f'],
    [']', ''],
    ['[', ''],
    ['a\nb', 'anb'],
    ['a\rb', 'arb'],
    ['a"b', 'ab'],
    ['x{2}', 'xx'],
    ['a?', ''],
    ['', 'a'],
  ])('matches %j literally and not %j', (value, other) => {
    const regex = new RegExp(toRegex([value]));
    expect(regex.test(value)).toBe(true);
    expect(regex.test(other)).toBe(false);
  });

  // What a double-quoted PromQL or LogQL string makes of the text between its quotes (the escape
  // sequences of a Go string literal). Throws where the query would be a parse error.
  const unquote = (text: string): string => {
    if (/(^|[^\\])(\\\\)*"/.test(text) || /[\n\r]/.test(text)) {
      throw new Error('the string ends early');
    }
    return text.replace(/\\(.)/g, (_, char: string) => {
      const known: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
      if (!(char in known)) {
        throw new Error(`unknown escape sequence \\${char}`);
      }
      return known[char];
    });
  };

  it.each([
    'node-a001.example.com',
    '[fd00::1]:9100',
    'a[b]',
    '[[host]]',
    ']',
    '[',
    'a\nb',
    'a\r\nb',
    'a\tb',
    '$__all',
    '${host:regex}',
    "a'b",
    'a`b',
    '(?i)plain',
    '.*',
  ])('means the same inside a double-quoted string for %j', (value) => {
    expect(needsQuoteEscaping(value)).toBe(false);
    const regex = new RegExp(unquote(toRegex([value, 'node-a1'])));
    expect(regex.test(value)).toBe(true);
    expect(regex.test('node-a1')).toBe(true);
    expect(regex.test(`${value}x`)).toBe(false);
  });

  // These have no form that a quoted string and a regular expression read alike. Pasted as they are,
  // the first two are a parse error and the others match another value: the bar warns about them.
  it.each([
    ['^a', 'error'],
    ['a"b', 'error'],
    ['a\\b', 'a'],
    ['a\\d', 'a1'],
    ['\\.', '[x]'],
  ])('says that %j needs escaping inside a quoted string (pasted as it is: %s)', (value, pasted) => {
    expect(needsQuoteEscaping(value)).toBe(true);
    // The expression itself is exact.
    expect(new RegExp(toRegex([value])).test(value)).toBe(true);
    let outcome: string;
    try {
      const regex = new RegExp(unquote(toRegex([value])));
      outcome = regex.test(value) ? 'exact' : regex.test(pasted) ? pasted : 'nothing';
    } catch {
      outcome = 'error';
    }
    expect(outcome).toBe(pasted);
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
