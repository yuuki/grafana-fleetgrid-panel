import { compactHostlist, compareNatural, isHostlistName } from './hostlist';

describe('compactHostlist', () => {
  it.each<[string[], string]>([
    [[], ''],
    [['node-a001'], 'node-a001'],
    [['login'], 'login'],
    // Zero-padded widths are part of the name: 001..012 and 1..12 are different ranges.
    [Array.from({ length: 12 }, (_, i) => `node-a${String(i + 1).padStart(3, '0')}`), 'node-a[001-012]'],
    [Array.from({ length: 12 }, (_, i) => `node-a${i + 1}`), 'node-a[1-12]'],
    // A padded range runs into the numbers that fill the width by themselves.
    [['node-a098', 'node-a099', 'node-a100', 'node-a101'], 'node-a[098-101]'],
    // Ranges that are not contiguous stay separate, single numbers stay single.
    [['node-a1', 'node-a2', 'node-a3', 'node-a7', 'node-a9', 'node-a10'], 'node-a[1-3,7,9-10]'],
    // The same number at two widths is two names.
    [['node-a1', 'node-a01', 'node-a001'], 'node-a[1,01,001]'],
    [['node-a1', 'node-a2', 'node-a01', 'node-a02'], 'node-a[1-2,01-02]'],
    // Mixed prefixes compact separately, in natural order; names without a number are listed as they are.
    [['node-b2', 'login', 'node-a2', 'node-b1', 'node-a1'], 'login,node-a[1-2],node-b[1-2]'],
    // Duplicates collapse and input order does not matter.
    [['node-a2', 'node-a1', 'node-a2', 'node-a1'], 'node-a[1-2]'],
    // Several numeric fields: the one that varies is compacted, the others stay in the text.
    [['node-a001.site2', 'node-a002.site2', 'node-a003.site2'], 'node-a[001-003].site2'],
    [['rack1-node01', 'rack1-node02', 'rack2-node01', 'rack2-node02'], 'rack1-node[01-02],rack2-node[01-02]'],
    [['gpu0', 'gpu1', 'gpu2', 'gpu3'], 'gpu[0-3]'],
    [['7', '8', '9'], '[7-9]'],
    [['node-a1-ib', 'node-a2-ib'], 'node-a[1-2]-ib'],
    // A digit run too long to be an exact number is text.
    [['id12345678901234567890', 'id12345678901234567891'], 'id12345678901234567890,id12345678901234567891'],
  ])('compacts %j to %s', (names, hostlist) => {
    expect(compactHostlist(names)).toBe(hostlist);
  });

  it.each([[['']], [['node-a1', 'a,b']], [['node[1]']], [['a]']]])('returns null for %j', (names) => {
    expect(compactHostlist(names)).toBeNull();
  });

  it('accepts any iterable', () => {
    expect(compactHostlist(new Set(['node-a2', 'node-a1']))).toBe('node-a[1-2]');
  });
});

describe('isHostlistName', () => {
  it('rejects the empty name and the notation punctuation', () => {
    expect(isHostlistName('node-a1.example')).toBe(true);
    expect(['', 'a,b', 'a[', 'a]'].map(isHostlistName)).toEqual([false, false, false, false]);
  });
});

describe('compareNatural', () => {
  it('orders numbers by value and never ties two different strings', () => {
    expect(['node-a10', 'node-a2', 'node-a1'].sort(compareNatural)).toEqual(['node-a1', 'node-a2', 'node-a10']);
    expect(compareNatural('node-a01', 'node-a1')).not.toBe(0);
    expect(compareNatural('node-a1', 'node-a1')).toBe(0);
  });
});
