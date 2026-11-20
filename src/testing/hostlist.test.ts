import { expandHostlist } from './hostlist';

// The expander is the oracle of the hostlist round-trip property, so its reading of the notation is
// pinned here against lists written by hand (the forms `scontrol show hostnames` expands).
describe('expandHostlist', () => {
  it.each<[string, string[]]>([
    ['', []],
    ['login1', ['login1']],
    ['node-a1,node-b7', ['node-a1', 'node-b7']],
    ['node-a[1-3]', ['node-a1', 'node-a2', 'node-a3']],
    ['node-a[001-003]', ['node-a001', 'node-a002', 'node-a003']],
    ['node-a[08-11]', ['node-a08', 'node-a09', 'node-a10', 'node-a11']],
    ['node-a[8-11]', ['node-a8', 'node-a9', 'node-a10', 'node-a11']],
    ['node-a[098-101]', ['node-a098', 'node-a099', 'node-a100', 'node-a101']],
    ['node-a[1,3,5-6]', ['node-a1', 'node-a3', 'node-a5', 'node-a6']],
    ['node-a[1,01]', ['node-a1', 'node-a01']],
    ['node-a[1-2]-ib', ['node-a1-ib', 'node-a2-ib']],
    ['node-a[1-2].site2,login', ['node-a1.site2', 'node-a2.site2', 'login']],
    ['rack[1-2]-node[01-02]', ['rack1-node01', 'rack1-node02', 'rack2-node01', 'rack2-node02']],
    ['[7-8]', ['7', '8']],
  ])('expands %s', (hostlist, names) => {
    expect(expandHostlist(hostlist)).toEqual(names);
  });

  it.each(['node[1-', 'node1]', 'node[3-1]', 'node[a-b]', 'node[1-2-3]', 'node[]'])('rejects %s', (hostlist) => {
    expect(() => expandHostlist(hostlist)).toThrow();
  });
});
