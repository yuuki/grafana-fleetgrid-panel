import {
  describeVariable,
  MAX_URL_CHARS,
  sameVariableValue,
  SyncOwnership,
  syncMessage,
  syncVariable,
  urlLength,
  VariableLike,
  VariableRuntime,
  VariableValue,
  variableName,
  variableValueFor,
} from './variable';

// A dashboard as Grafana 11.6 and 12.4 report it through getTemplateSrv().getVariables(): "All" is
// `$__all`, a multi-value variable holds a list, a single-value one a string.
const dashboard = (): VariableLike[] => [
  { name: 'hosts', type: 'custom', multi: true, current: { value: '$__all' } },
  { name: 'one_host', type: 'custom', current: { value: 'node-a1' } },
  { name: 'host_regex', type: 'textbox', current: { value: '.*' } },
  { name: 'fixed', type: 'constant', current: { value: 'c0' } },
  { name: 'filters', type: 'adhoc' },
];

// Applies a write the way Grafana does: the URL parameter becomes the variable's current value.
function fakeRuntime(variables: VariableLike[] = dashboard()) {
  const writes: Array<Record<string, VariableValue>> = [];
  const runtime: VariableRuntime = {
    getVariables: () => variables,
    setQuery: (query) => {
      writes.push(query);
      for (const [key, value] of Object.entries(query)) {
        const variable = variables.find((v) => `var-${v.name}` === key);
        if (variable) {
          variable.current = { value };
        }
      }
    },
  };
  const valueOf = (name: string) => variables.find((v) => v.name === name)?.current?.value;
  return { runtime, writes, valueOf, variables };
}

describe('variableName', () => {
  it.each([
    ['hosts', 'hosts'],
    ['$hosts', 'hosts'],
    ['${hosts}', 'hosts'],
    ['  hosts ', 'hosts'],
    ['', ''],
    [undefined, ''],
  ])('reads %j as %j', (option, name) => {
    expect(variableName(option)).toBe(name);
  });
});

describe('describeVariable', () => {
  it('tells multi-value, single-value, unsupported and missing variables apart', () => {
    const variables = dashboard();
    expect(describeVariable(variables, 'hosts')).toEqual({ status: 'ok', multi: true, value: '$__all' });
    expect(describeVariable(variables, 'one_host')).toEqual({ status: 'ok', multi: false, value: 'node-a1' });
    expect(describeVariable(variables, 'host_regex')).toEqual({ status: 'ok', multi: false, value: '.*' });
    expect(describeVariable(variables, 'fixed')).toEqual({ status: 'unsupported', type: 'constant' });
    expect(describeVariable(variables, 'filters')).toEqual({ status: 'unsupported', type: 'adhoc' });
    expect(describeVariable(variables, 'nope')).toEqual({ status: 'missing' });
  });

  it('reads a variable without a current value as holding nothing', () => {
    expect(describeVariable([{ name: 'v', type: 'query', multi: true, current: {} }], 'v')).toEqual({
      status: 'ok',
      multi: true,
      value: undefined,
    });
  });
});

describe('variable values', () => {
  it('gives a multi-value variable the raw values and a single-value variable one regular expression', () => {
    expect(variableValueFor(['node-a1.example', 'node-a2.example'], true)).toEqual([
      'node-a1.example',
      'node-a2.example',
    ]);
    expect(variableValueFor(['node-a1.example', 'node-a2.example'], false)).toBe(
      '^(node-a1[.]example|node-a2[.]example)$'
    );
  });

  it('measures the URL characters of the var- parameters', () => {
    expect(urlLength('hosts', ['node-a1', 'node-a2'])).toBe('var-hosts=node-a1&var-hosts=node-a2&'.length);
    expect(urlLength('h', '^(a|b)$')).toBe('var-h=%5E(a%7Cb)%24&'.length);
    // A lone surrogate cannot be percent-encoded.
    expect(urlLength('h', ['\ud800'])).toBe(Infinity);
  });

  it('compares values as sets and treats the two spellings of All as one', () => {
    expect(sameVariableValue(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameVariableValue('$__all', ['$__all'])).toBe(true);
    expect(sameVariableValue(['a'], ['a', 'b'])).toBe(false);
    expect(sameVariableValue('a', 'b')).toBe(false);
    expect(sameVariableValue(undefined, undefined)).toBe(true);
    expect(sameVariableValue(undefined, 'a')).toBe(false);
  });
});

describe('syncVariable', () => {
  it('does nothing without a variable name', () => {
    const { runtime, writes } = fakeRuntime();
    expect(syncVariable(runtime, '', ['node-a1'], null)).toEqual({ status: { state: 'off' }, owned: null });
    expect(writes).toEqual([]);
  });

  it('writes the values to a multi-value variable and puts All back when the selection ends', () => {
    const { runtime, writes, valueOf } = fakeRuntime();
    const first = syncVariable(runtime, 'hosts', ['node-a1', 'node-a2'], null);
    expect(first.status).toEqual({ state: 'synced', name: 'hosts' });
    expect(valueOf('hosts')).toEqual(['node-a1', 'node-a2']);

    const second = syncVariable(runtime, 'hosts', ['node-a1'], first.owned);
    expect(valueOf('hosts')).toEqual(['node-a1']);

    const cleared = syncVariable(runtime, 'hosts', [], second.owned);
    expect(cleared).toEqual({ status: { state: 'idle', name: 'hosts' }, owned: null });
    expect(valueOf('hosts')).toBe('$__all');
    expect(writes).toEqual([
      { 'var-hosts': ['node-a1', 'node-a2'] },
      { 'var-hosts': ['node-a1'] },
      { 'var-hosts': '$__all' },
    ]);
  });

  it('writes one regular expression to a single-value variable and restores its text', () => {
    const { runtime, valueOf } = fakeRuntime();
    const first = syncVariable(runtime, 'host_regex', ['node-a1.example', 'node-a2.example'], null);
    expect(valueOf('host_regex')).toBe('^(node-a1[.]example|node-a2[.]example)$');
    syncVariable(runtime, 'host_regex', [], first.owned);
    expect(valueOf('host_regex')).toBe('.*');
  });

  it('does not write again for the same values, so a data refresh leaves the URL alone', () => {
    const { runtime, writes } = fakeRuntime();
    const first = syncVariable(runtime, 'hosts', ['node-a1', 'node-a2'], null);
    const again = syncVariable(runtime, 'hosts', ['node-a2', 'node-a1'], first.owned);
    expect(again.owned).toBe(first.owned);
    expect(writes).toHaveLength(1);
    // Not even when someone changed the variable meanwhile: the panel does not fight over it.
    runtime.setQuery({ 'var-hosts': ['node-b1'] });
    syncVariable(runtime, 'hosts', ['node-a1', 'node-a2'], again.owned);
    expect(writes).toHaveLength(2);
  });

  it('leaves a variable alone that was changed by someone else when the selection ends', () => {
    const { runtime, writes, valueOf } = fakeRuntime();
    const first = syncVariable(runtime, 'hosts', ['node-a1'], null);
    runtime.setQuery({ 'var-hosts': ['node-b1'] });
    const cleared = syncVariable(runtime, 'hosts', [], first.owned);
    expect(cleared.owned).toBeNull();
    expect(valueOf('hosts')).toEqual(['node-b1']);
    expect(writes).toHaveLength(2);
  });

  it('nothing is selected and nothing was written: the variable is not touched', () => {
    const { runtime, writes } = fakeRuntime();
    expect(syncVariable(runtime, 'hosts', [], null)).toEqual({ status: { state: 'idle', name: 'hosts' }, owned: null });
    expect(writes).toEqual([]);
  });

  it('reports a variable that is missing or of an unsupported type and writes nothing', () => {
    const { runtime, writes } = fakeRuntime();
    expect(syncVariable(runtime, 'nope', ['node-a1'], null).status).toEqual({ state: 'missing', name: 'nope' });
    expect(syncVariable(runtime, 'fixed', ['node-a1'], null).status).toEqual({
      state: 'unsupported',
      name: 'fixed',
      type: 'constant',
    });
    expect(writes).toEqual([]);
  });

  it('refuses a selection that is too large for the URL and restores the variable', () => {
    const { runtime, writes, valueOf } = fakeRuntime();
    const first = syncVariable(runtime, 'hosts', ['node-a1'], null);
    const many = Array.from({ length: 1000 }, (_, i) => `node-a${String(i).padStart(4, '0')}`);
    const result = syncVariable(runtime, 'hosts', many, first.owned);
    expect(result.status).toEqual({ state: 'tooLarge', name: 'hosts', length: urlLength('hosts', many) });
    expect(urlLength('hosts', many)).toBeGreaterThan(MAX_URL_CHARS);
    expect(result.owned).toBeNull();
    expect(valueOf('hosts')).toBe('$__all');
    expect(writes).toHaveLength(2);
    // Just under the limit is written.
    const fits = many.slice(0, Math.floor(MAX_URL_CHARS / 'var-hosts=node-a0000&'.length));
    expect(syncVariable(runtime, 'hosts', fits, null).status.state).toBe('synced');
  });

  it('restores the old variable when the option names another one', () => {
    const { runtime, valueOf } = fakeRuntime();
    const first = syncVariable(runtime, 'hosts', ['node-a1'], null);
    const moved = syncVariable(runtime, 'host_regex', ['node-a1'], first.owned);
    expect(valueOf('hosts')).toBe('$__all');
    expect(valueOf('host_regex')).toBe('^(node-a1)$');
    expect(moved.owned).toMatchObject({ name: 'host_regex', previous: '.*' });
    // Turning the sync off restores as well.
    expect(syncVariable(runtime, '', ['node-a1'], moved.owned)).toEqual({ status: { state: 'off' }, owned: null });
    expect(valueOf('host_regex')).toBe('.*');
  });

  it('keeps the first previous value across several writes, and cannot restore an empty list', () => {
    const { runtime, valueOf } = fakeRuntime([{ name: 'v', type: 'query', multi: true, current: { value: [] } }]);
    const first = syncVariable(runtime, 'v', ['a'], null);
    const second = syncVariable(runtime, 'v', ['a', 'b'], first.owned);
    expect((second.owned as SyncOwnership).previous).toEqual([]);
    syncVariable(runtime, 'v', [], second.owned);
    // Grafana ignores an empty list in the URL, so nothing is written and the value stays.
    expect(valueOf('v')).toEqual(['a', 'b']);
  });
});

describe('syncMessage', () => {
  it('names the variable when synced and explains every failure', () => {
    expect(syncMessage({ state: 'off' })).toBeUndefined();
    expect(syncMessage({ state: 'idle', name: 'hosts' })).toBeUndefined();
    expect(syncMessage({ state: 'synced', name: 'hosts' })).toEqual({ text: '→ $hosts', problem: false });
    expect(syncMessage({ state: 'missing', name: 'hosts' })).toEqual({
      text: 'Variable "hosts" is not in this dashboard',
      problem: true,
    });
    expect(syncMessage({ state: 'unsupported', name: 'f', type: 'adhoc' })?.text).toContain('adhoc');
    expect(syncMessage({ state: 'tooLarge', name: 'hosts', length: 7000 })?.text).toContain('7000 of 6000');
    expect(syncMessage({ state: 'failed', name: 'hosts' })?.problem).toBe(true);
  });
});
