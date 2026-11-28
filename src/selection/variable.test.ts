import {
  ALL_VALUE,
  CONFIRM_MS,
  describeVariable,
  MAX_URL_CHARS,
  sameVariableValue,
  syncMessage,
  urlLength,
  VariableLike,
  VariableRuntime,
  VariableSync,
  VariableValue,
  variableName,
  variableValueFor,
} from './variable';

// A dashboard as Grafana 11.6 to 13.3 report it through getTemplateSrv().getVariables(): "All" is
// `$__all`, a multi-value variable holds a list, a single-value one a string.
const dashboard = (): VariableLike[] => [
  { name: 'hosts', type: 'custom', multi: true, current: { value: '$__all' } },
  { name: 'query_hosts', type: 'query', multi: true, current: { value: ['node-a001'] } },
  { name: 'host_regex', type: 'textbox', current: { value: '.*' } },
  { name: 'one_host', type: 'custom', current: { value: 'node-a001' } },
  { name: 'one_query_host', type: 'query', multi: false, current: { value: 'node-a001' } },
  { name: 'fixed', type: 'constant', current: { value: 'c0' } },
  { name: 'filters', type: 'adhoc' },
];

// A stand-in for Grafana: a write to the URL becomes the variable's value, at once unless `apply`
// says otherwise. Tests change `variables` directly to act as Grafana or as a user.
function fakeGrafana(variables: VariableLike[] = dashboard()) {
  const writes: Array<Record<string, VariableValue>> = [];
  const state = {
    now: 1_000_000,
    path: '/d/fleet/fleet',
    apply: (variable: VariableLike, value: VariableValue) => {
      variable.current = { value };
    },
  };
  const runtime: VariableRuntime = {
    getVariables: () => variables,
    setQuery: (query) => {
      writes.push(query);
      for (const [key, value] of Object.entries(query)) {
        const variable = variables.find((v) => `var-${v.name}` === key);
        if (variable) {
          state.apply(variable, value);
        }
      }
    },
    path: () => state.path,
    now: () => state.now,
  };
  const variable = (name: string) => variables.find((v) => v.name === name)!;
  return {
    sync: new VariableSync(runtime),
    writes,
    state,
    valueOf: (name: string) => variable(name).current?.value,
    set: (name: string, value: VariableValue) => {
      variable(name).current = { value };
    },
  };
}

const panel = () => ({});

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
  it('accepts multi-value custom and query variables and text boxes', () => {
    const variables = dashboard();
    expect(describeVariable(variables, 'hosts')).toEqual({ status: 'ok', multi: true, value: '$__all' });
    expect(describeVariable(variables, 'query_hosts')).toEqual({ status: 'ok', multi: true, value: ['node-a001'] });
    expect(describeVariable(variables, 'host_regex')).toEqual({ status: 'ok', multi: false, value: '.*' });
  });

  it('refuses a custom or query variable that takes one value, with or without Include All', () => {
    const variables: VariableLike[] = [
      ...dashboard(),
      {
        name: 'one_with_all',
        type: 'query',
        multi: false,
        includeAll: true,
        current: { value: '$__all' },
      } as VariableLike,
    ];
    expect(describeVariable(variables, 'one_host')).toEqual({ status: 'single' });
    expect(describeVariable(variables, 'one_query_host')).toEqual({ status: 'single' });
    expect(describeVariable(variables, 'one_with_all')).toEqual({ status: 'single' });
  });

  it('refuses the types that hold something else than label values, and a name that is not there', () => {
    const variables: VariableLike[] = [
      ...dashboard(),
      { name: 'step', type: 'interval', current: { value: '1m' } },
      { name: 'source', type: 'datasource', multi: true, current: { value: ['prom'] } },
    ];
    expect(describeVariable(variables, 'fixed')).toEqual({ status: 'unsupported', type: 'constant' });
    expect(describeVariable(variables, 'filters')).toEqual({ status: 'unsupported', type: 'adhoc' });
    expect(describeVariable(variables, 'step')).toEqual({ status: 'unsupported', type: 'interval' });
    expect(describeVariable(variables, 'source')).toEqual({ status: 'unsupported', type: 'datasource' });
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
  it('gives a multi-value variable the raw values and a text box one regular expression', () => {
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

describe('VariableSync', () => {
  describe('one panel', () => {
    it('writes the values, says "synced" only after reading them back, and puts All back at the end', () => {
      const { sync, writes, valueOf } = fakeGrafana();
      const p = panel();
      sync.claim('hosts', p, ['node-a001', 'node-a002']);
      // Written, not yet read back: no claim that the variable holds the selection.
      expect(sync.status('hosts', p)).toEqual({ state: 'writing', name: 'hosts' });
      sync.verify();
      expect(sync.status('hosts', p)).toEqual({ state: 'synced', name: 'hosts', others: 0 });
      expect(valueOf('hosts')).toEqual(['node-a001', 'node-a002']);

      sync.claim('hosts', p, ['node-a001']);
      sync.verify();
      expect(valueOf('hosts')).toEqual(['node-a001']);

      sync.claim('hosts', p, []);
      expect(sync.status('hosts', p)).toEqual({ state: 'idle', name: 'hosts' });
      expect(valueOf('hosts')).toBe('$__all');
      expect(writes).toEqual([
        { 'var-hosts': ['node-a001', 'node-a002'] },
        { 'var-hosts': ['node-a001'] },
        { 'var-hosts': '$__all' },
      ]);
    });

    it('writes one regular expression to a text box and restores its text', () => {
      const { sync, valueOf } = fakeGrafana();
      const p = panel();
      sync.claim('host_regex', p, ['node-a1.example', 'node-a2.example']);
      sync.verify();
      expect(valueOf('host_regex')).toBe('^(node-a1[.]example|node-a2[.]example)$');
      expect(sync.status('host_regex', p).state).toBe('synced');
      sync.claim('host_regex', p, []);
      expect(valueOf('host_regex')).toBe('.*');
    });

    it('does not write again for the same values, so a data refresh leaves the URL alone', () => {
      const { sync, writes } = fakeGrafana();
      const p = panel();
      sync.claim('hosts', p, ['node-a001', 'node-a002']);
      sync.claim('hosts', p, ['node-a002', 'node-a001']);
      sync.verify();
      sync.claim('hosts', p, ['node-a001', 'node-a002']);
      expect(writes).toHaveLength(1);
    });

    it('does nothing for a panel that never selected anything', () => {
      const { sync, writes } = fakeGrafana();
      const p = panel();
      sync.claim('hosts', p, []);
      sync.verify();
      expect(sync.status('hosts', p)).toEqual({ state: 'idle', name: 'hosts' });
      expect(writes).toEqual([]);
    });
  });

  describe('variables that cannot hold a selection', () => {
    it.each([
      ['one_host', { state: 'single', name: 'one_host' }],
      ['one_query_host', { state: 'single', name: 'one_query_host' }],
      ['fixed', { state: 'unsupported', name: 'fixed', type: 'constant' }],
      ['filters', { state: 'unsupported', name: 'filters', type: 'adhoc' }],
      ['nope', { state: 'missing', name: 'nope' }],
    ])('writes nothing to %s and says why', (name, status) => {
      const { sync, writes } = fakeGrafana();
      const p = panel();
      sync.claim(name, p, ['node-b001', 'node-b002']);
      sync.verify();
      expect(sync.status(name, p)).toEqual(status);
      sync.claim(name, p, []);
      expect(writes).toEqual([]);
    });

    it('refuses a multi-value variable that holds nothing, because nothing could be put back', () => {
      // Grafana drops an empty list from the URL and keeps the variable's value.
      const { sync, writes } = fakeGrafana([
        { name: 'empty_list', type: 'query', multi: true, current: { value: [] } },
        { name: 'no_value', type: 'query', multi: true, current: {} },
        { name: 'empty_text', type: 'textbox', current: { value: '' } },
      ]);
      const p = panel();
      sync.claim('empty_list', p, ['node-a001']);
      sync.claim('no_value', p, ['node-a001']);
      expect(sync.status('empty_list', p)).toEqual({ state: 'unrestorable', name: 'empty_list' });
      expect(sync.status('no_value', p)).toEqual({ state: 'unrestorable', name: 'no_value' });
      expect(writes).toEqual([]);
      // An empty text box can be restored: the URL can carry an empty text.
      sync.claim('empty_text', p, ['node-a001']);
      sync.claim('empty_text', p, []);
      expect(writes).toEqual([{ 'var-empty_text': '^(node-a001)$' }, { 'var-empty_text': '' }]);
    });

    it("refuses a value that is Grafana's token for All, which would select every host", () => {
      const { sync, writes, valueOf } = fakeGrafana();
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      sync.verify();
      sync.claim('hosts', p, ['node-a001', ALL_VALUE]);
      expect(sync.status('hosts', p)).toEqual({ state: 'reserved', name: 'hosts' });
      // The earlier selection is taken out of the variable again.
      expect(valueOf('hosts')).toBe('$__all');
      expect(writes).toHaveLength(2);
      // In a text box the token is only part of an expression.
      sync.claim('host_regex', p, [ALL_VALUE]);
      expect(valueOf('host_regex')).toBe('^([$]__all)$');
    });

    // Grafana puts the text of a text box into the query string of the panel that uses it. Whether a
    // backslash is escaped on the way depends on the data source: where it is not, `^(a\\d)$` arrives
    // as the expression `^(a\d)$` and filters the other panel to hosts that were not selected.
    it.each([['a\\d'], ['^a'], ['a"b']])(
      'refuses to write %j to a text box, whose expression a quoted string would read differently',
      (value) => {
        const { sync, writes, valueOf } = fakeGrafana();
        const p = panel();
        sync.claim('host_regex', p, ['node-a001']);
        sync.verify();
        sync.claim('host_regex', p, ['node-a001', value]);
        expect(sync.status('host_regex', p)).toEqual({ state: 'unquotable', name: 'host_regex' });
        // The earlier selection is taken out of the text box again.
        expect(valueOf('host_regex')).toBe('.*');
        expect(writes).toHaveLength(2);
        // A multi-value variable holds the value itself, and Grafana escapes it for each query.
        sync.claim('hosts', p, ['node-a001', value]);
        sync.verify();
        expect(valueOf('hosts')).toEqual(['node-a001', value].sort());
        expect(sync.status('hosts', p).state).toBe('synced');
      }
    );

    it('writes brackets and line breaks to a text box in a form that a quoted string reads as it is', () => {
      const { sync, valueOf } = fakeGrafana();
      const p = panel();
      sync.claim('host_regex', p, ['[fd00::1]:9100', 'a\nb']);
      sync.verify();
      expect(valueOf('host_regex')).toBe('^([[]fd00::1]:9100|a\\nb)$');
      expect(sync.status('host_regex', p).state).toBe('synced');
    });

    it('refuses a selection that is too large for the URL and restores the variable', () => {
      const { sync, writes, valueOf } = fakeGrafana();
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      sync.verify();
      const many = Array.from({ length: 1000 }, (_, i) => `node-a${String(i).padStart(4, '0')}`);
      sync.claim('hosts', p, many);
      expect(sync.status('hosts', p)).toEqual({ state: 'tooLarge', name: 'hosts', length: urlLength('hosts', many) });
      expect(urlLength('hosts', many)).toBeGreaterThan(MAX_URL_CHARS);
      expect(valueOf('hosts')).toBe('$__all');
      expect(writes).toHaveLength(2);
      // Just under the limit is written.
      const fits = many.slice(0, Math.floor(MAX_URL_CHARS / 'var-hosts=node-a0000&'.length));
      sync.claim('hosts', p, fits);
      sync.verify();
      expect(sync.status('hosts', p).state).toBe('synced');
    });

    it('reports a write that Grafana throws on', () => {
      const { sync, state } = fakeGrafana();
      state.apply = () => {
        throw new Error('URI malformed');
      };
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      expect(sync.status('hosts', p)).toEqual({ state: 'failed', name: 'hosts' });
    });
  });

  describe('reading the variable back', () => {
    it('says "changed" when Grafana resets the variable at a refresh, and does not write again', () => {
      // A query variable re-reads its options at a dashboard refresh and drops values that are not
      // among them. Here its options do not contain the selected hosts.
      const { sync, writes, valueOf, set } = fakeGrafana();
      const p = panel();
      sync.claim('query_hosts', p, ['node-b001', 'node-b002']);
      sync.verify();
      expect(sync.status('query_hosts', p).state).toBe('synced');

      set('query_hosts', ['node-a001']); // Grafana, at the refresh
      sync.verify();
      expect(sync.status('query_hosts', p)).toEqual({ state: 'changed', name: 'query_hosts' });

      // The data update that follows states the same values again: nothing is written.
      sync.claim('query_hosts', p, ['node-b001', 'node-b002']);
      sync.verify();
      expect(writes).toHaveLength(1);
      expect(sync.status('query_hosts', p).state).toBe('changed');

      // The variable is Grafana's now: clearing the selection leaves it alone.
      sync.claim('query_hosts', p, []);
      expect(valueOf('query_hosts')).toEqual(['node-a001']);
      expect(writes).toHaveLength(1);
    });

    it('waits for Grafana to apply the write before judging it', () => {
      const { sync, state, set } = fakeGrafana();
      state.apply = () => {}; // Grafana has not applied the URL yet
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      state.now += CONFIRM_MS - 1;
      sync.verify();
      expect(sync.status('hosts', p).state).toBe('writing');
      set('hosts', ['node-a001']);
      sync.verify();
      expect(sync.status('hosts', p).state).toBe('synced');
    });

    it('says "rejected" and writes nothing more when Grafana makes something else of the write', () => {
      const { sync, state, writes, valueOf } = fakeGrafana();
      // Grafana takes the write and turns it into a value that was not written.
      state.apply = (variable) => {
        variable.current = { value: ['node-zzz'] };
      };
      const p = panel();
      sync.claim('query_hosts', p, ['node-b001']);
      state.now += CONFIRM_MS;
      sync.verify();
      expect(sync.status('query_hosts', p)).toEqual({ state: 'rejected', name: 'query_hosts' });
      // The value is not the sync's, so nothing is written over it.
      expect(valueOf('query_hosts')).toEqual(['node-zzz']);
      expect(writes).toEqual([{ 'var-query_hosts': ['node-b001'] }]);
      // And it stays that way: at the next read-back, at a data update, and at Clear.
      sync.verify();
      sync.claim('query_hosts', p, ['node-b001']);
      sync.claim('query_hosts', p, []);
      expect(valueOf('query_hosts')).toEqual(['node-zzz']);
      expect(writes).toHaveLength(1);
    });

    it('does not overwrite a value that the user picked while the write was not yet read back', () => {
      const { sync, state, writes, valueOf, set } = fakeGrafana();
      state.apply = () => {}; // Grafana never shows the written value
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      state.now += 1000;
      sync.verify();
      set('hosts', ['node-b777']); // the user, with the variable picker
      state.now += CONFIRM_MS;
      sync.verify();
      expect(sync.status('hosts', p)).toEqual({ state: 'rejected', name: 'hosts' });
      expect(valueOf('hosts')).toEqual(['node-b777']);
      sync.claim('hosts', p, []);
      expect(valueOf('hosts')).toEqual(['node-b777']);
      expect(writes).toEqual([{ 'var-hosts': ['node-a001'] }]);
    });

    describe('a variable that lost a part of the selection', () => {
      // A query variable whose options are the hosts of zone-a only: at a dashboard refresh Grafana
      // drops the selected hosts that are not among them.
      const synced = () => {
        const grafana = fakeGrafana();
        const p = panel();
        grafana.sync.claim('hosts', p, ['node-a001', 'node-b001']);
        grafana.sync.verify();
        expect(grafana.sync.status('hosts', p).state).toBe('synced');
        return { ...grafana, p };
      };

      it('says how much the variable still holds, and does not write the selection again', () => {
        const { sync, writes, set, p } = synced();
        set('hosts', ['node-a001']); // Grafana, at the refresh
        sync.verify();
        expect(sync.status('hosts', p)).toEqual({ state: 'partial', name: 'hosts', kept: 1, of: 2 });
        // The data update that follows states the same values again.
        sync.claim('hosts', p, ['node-a001', 'node-b001']);
        sync.verify();
        expect(writes).toHaveLength(1);
        expect(sync.status('hosts', p).state).toBe('partial');
      });

      it('puts the original value back at Clear, so that no selected value stays behind', () => {
        const { sync, writes, valueOf, set, p } = synced();
        set('hosts', ['node-a001']);
        sync.verify();
        sync.claim('hosts', p, []);
        expect(valueOf('hosts')).toBe('$__all');
        expect(writes).toEqual([{ 'var-hosts': ['node-a001', 'node-b001'] }, { 'var-hosts': '$__all' }]);
      });

      it('puts the original value back when the part was not noticed before Clear', () => {
        const { sync, valueOf, set, p } = synced();
        set('hosts', ['node-a001']);
        sync.claim('hosts', p, []);
        expect(valueOf('hosts')).toBe('$__all');
      });

      it('keeps the original value as the one to put back when the selection changes', () => {
        const { sync, valueOf, set, p } = synced();
        set('hosts', ['node-a001']);
        sync.verify();
        sync.claim('hosts', p, ['node-a002']);
        sync.verify();
        expect(sync.status('hosts', p).state).toBe('synced');
        sync.claim('hosts', p, []);
        // Not `node-a001`, which is what was left of the first selection.
        expect(valueOf('hosts')).toBe('$__all');
      });

      it('says "synced" again when the variable holds all values again', () => {
        const { sync, set, p } = synced();
        set('hosts', ['node-b001']);
        sync.verify();
        expect(sync.status('hosts', p).state).toBe('partial');
        set('hosts', ['node-b001', 'node-a001']);
        sync.verify();
        expect(sync.status('hosts', p)).toEqual({ state: 'synced', name: 'hosts', others: 0 });
      });

      it('treats a variable that holds none of the values as a part too', () => {
        const { sync, valueOf, set, p } = synced();
        set('hosts', []);
        sync.verify();
        expect(sync.status('hosts', p)).toEqual({ state: 'partial', name: 'hosts', kept: 0, of: 2 });
        sync.claim('hosts', p, []);
        expect(valueOf('hosts')).toBe('$__all');
      });

      it('gives the variable up as soon as it holds one value that was not written', () => {
        const { sync, writes, valueOf, set, p } = synced();
        set('hosts', ['node-a001']);
        sync.verify();
        set('hosts', ['node-a001', 'node-b009']); // the user adds a host
        sync.verify();
        expect(sync.status('hosts', p)).toEqual({ state: 'changed', name: 'hosts' });
        sync.claim('hosts', p, []);
        expect(valueOf('hosts')).toEqual(['node-a001', 'node-b009']);
        expect(writes).toHaveLength(1);
      });

      it('recognizes a part when Grafana drops values at the write itself', () => {
        const { sync, state, valueOf } = fakeGrafana();
        // Grafana keeps "All" and, of a list, the hosts of zone-a.
        state.apply = (variable, value) => {
          variable.current = {
            value: Array.isArray(value) ? value.filter((item) => item.startsWith('node-a')) : value,
          };
        };
        const p = panel();
        sync.claim('hosts', p, ['node-a001', 'node-b001']);
        sync.verify();
        // Grafana may not have applied the write yet: no verdict.
        expect(sync.status('hosts', p).state).toBe('writing');
        state.now += CONFIRM_MS;
        sync.verify();
        expect(sync.status('hosts', p)).toEqual({ state: 'partial', name: 'hosts', kept: 1, of: 2 });
        sync.claim('hosts', p, []);
        expect(valueOf('hosts')).toBe('$__all');
      });

      it('holds the part of two panels together and restores after the last one', () => {
        const { sync, valueOf, set, p } = synced();
        const q = panel();
        sync.claim('hosts', q, ['node-c001']);
        sync.verify();
        set('hosts', ['node-a001', 'node-c001']); // Grafana drops node-b001
        sync.verify();
        expect(sync.status('hosts', q)).toEqual({ state: 'partial', name: 'hosts', kept: 2, of: 3 });
        sync.claim('hosts', p, []);
        sync.verify();
        expect(valueOf('hosts')).toEqual(['node-c001']);
        expect(sync.status('hosts', q)).toEqual({ state: 'synced', name: 'hosts', others: 0 });
        sync.claim('hosts', q, []);
        expect(valueOf('hosts')).toBe('$__all');
      });

      it('never takes a text box for holding a part: its expression is the written one or not', () => {
        const { sync, writes, valueOf, set } = fakeGrafana();
        const p = panel();
        sync.claim('host_regex', p, ['node-a001', 'node-a002']);
        sync.verify();
        set('host_regex', '^(node-a001)$');
        sync.verify();
        expect(sync.status('host_regex', p)).toEqual({ state: 'changed', name: 'host_regex' });
        sync.claim('host_regex', p, []);
        expect(valueOf('host_regex')).toBe('^(node-a001)$');
        expect(writes).toHaveLength(1);
      });
    });

    it('leaves a variable alone that the user changed by hand, and takes that value as the one to restore', () => {
      const { sync, writes, valueOf, set } = fakeGrafana();
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      sync.verify();
      set('hosts', ['node-b009']); // the user, with the variable picker
      sync.verify();
      expect(sync.status('hosts', p)).toEqual({ state: 'changed', name: 'hosts' });

      // A new selection is a new decision of the user: it is written, and what the user had picked
      // is what Clear puts back, not the value from before the first selection.
      sync.claim('hosts', p, ['node-a001', 'node-a002']);
      sync.verify();
      expect(sync.status('hosts', p).state).toBe('synced');
      sync.claim('hosts', p, []);
      expect(valueOf('hosts')).toEqual(['node-b009']);
      expect(writes).toEqual([
        { 'var-hosts': ['node-a001'] },
        { 'var-hosts': ['node-a001', 'node-a002'] },
        { 'var-hosts': ['node-b009'] },
      ]);
    });

    it('does not restore a variable that the user changed while it held the selection', () => {
      const { sync, writes, valueOf, set } = fakeGrafana();
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      sync.verify();
      set('hosts', ['node-b009']);
      // Cleared before any read-back noticed the change.
      sync.claim('hosts', p, []);
      expect(valueOf('hosts')).toEqual(['node-b009']);
      expect(writes).toHaveLength(1);
    });

    it('reports a variable that disappears or changes its type', () => {
      const variables = dashboard();
      const { sync } = fakeGrafana(variables);
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      sync.verify();
      variables[0].multi = false;
      sync.verify();
      expect(sync.status('hosts', p)).toEqual({ state: 'single', name: 'hosts' });
      variables.splice(0, 1);
      sync.claim('hosts', p, ['node-a002']);
      expect(sync.status('hosts', p)).toEqual({ state: 'missing', name: 'hosts' });
    });
  });

  describe('several panels and one variable', () => {
    it('holds the union of their selections and restores the original value after the last one', () => {
      const { sync, writes, valueOf } = fakeGrafana();
      const one = panel();
      const two = panel();
      sync.claim('hosts', one, ['node-a001']);
      sync.verify();
      sync.claim('hosts', two, ['node-b001']);
      sync.verify();
      expect(valueOf('hosts')).toEqual(['node-a001', 'node-b001']);
      expect(sync.status('hosts', one)).toEqual({ state: 'synced', name: 'hosts', others: 1 });
      expect(sync.status('hosts', two)).toEqual({ state: 'synced', name: 'hosts', others: 1 });

      // Clearing panel one leaves panel two's selection, not a stale value of panel one.
      sync.claim('hosts', one, []);
      sync.verify();
      expect(valueOf('hosts')).toEqual(['node-b001']);
      expect(sync.status('hosts', one)).toEqual({ state: 'idle', name: 'hosts' });
      expect(sync.status('hosts', two)).toEqual({ state: 'synced', name: 'hosts', others: 0 });

      // Clearing panel two puts back All, the value from before either selection.
      sync.claim('hosts', two, []);
      expect(valueOf('hosts')).toBe('$__all');
      expect(writes).toEqual([
        { 'var-hosts': ['node-a001'] },
        { 'var-hosts': ['node-a001', 'node-b001'] },
        { 'var-hosts': ['node-b001'] },
        { 'var-hosts': '$__all' },
      ]);
    });

    it('restores the original value in whatever order the panels are cleared', () => {
      const { sync, valueOf } = fakeGrafana();
      const one = panel();
      const two = panel();
      sync.claim('hosts', one, ['node-a001']);
      sync.claim('hosts', two, ['node-b001']);
      sync.verify();
      sync.claim('hosts', two, []);
      expect(valueOf('hosts')).toEqual(['node-a001']);
      sync.claim('hosts', one, []);
      expect(valueOf('hosts')).toBe('$__all');
    });

    it('writes a value that two panels share once', () => {
      const { sync, writes, valueOf } = fakeGrafana();
      const one = panel();
      const two = panel();
      sync.claim('hosts', one, ['node-a001']);
      sync.claim('hosts', two, ['node-a001']);
      sync.claim('hosts', one, []);
      expect(valueOf('hosts')).toEqual(['node-a001']);
      expect(writes).toHaveLength(1);
    });

    it('tells every panel when a status changes', () => {
      const { sync, set } = fakeGrafana();
      const listener = jest.fn();
      const stop = sync.subscribe(listener);
      const p = panel();
      sync.claim('hosts', p, ['node-a001']);
      expect(listener).toHaveBeenCalledTimes(1);
      sync.verify(); // writing → synced
      expect(listener).toHaveBeenCalledTimes(2);
      sync.verify(); // nothing new
      expect(listener).toHaveBeenCalledTimes(2);
      set('hosts', '$__all');
      sync.verify(); // synced → changed
      expect(listener).toHaveBeenCalledTimes(3);
      stop();
      sync.claim('hosts', p, []);
      expect(listener).toHaveBeenCalledTimes(3);
    });
  });

  it('never writes to another page: a panel that unmounts during navigation only drops its claim', () => {
    const { sync, writes, state } = fakeGrafana();
    const p = panel();
    sync.claim('hosts', p, ['node-a001']);
    sync.verify();
    state.path = '/d/other/dashboard';
    sync.verify();
    sync.claim('hosts', p, []);
    expect(writes).toHaveLength(1);
    expect(sync.status('hosts', p)).toEqual({ state: 'idle', name: 'hosts' });
  });
});

describe('syncMessage', () => {
  it('claims the variable only when it was read back, and explains everything else', () => {
    expect(syncMessage({ state: 'off' })).toBeUndefined();
    expect(syncMessage({ state: 'idle', name: 'hosts' })).toBeUndefined();
    expect(syncMessage({ state: 'writing', name: 'hosts' })).toEqual({ text: 'Writing $hosts…', problem: false });
    expect(syncMessage({ state: 'synced', name: 'hosts', others: 0 })).toEqual({ text: '→ $hosts', problem: false });
    expect(syncMessage({ state: 'synced', name: 'hosts', others: 1 })?.text).toBe('→ $hosts (with 1 other panel)');
    expect(syncMessage({ state: 'synced', name: 'hosts', others: 2 })?.text).toBe('→ $hosts (with 2 other panels)');
    for (const state of [
      'changed',
      'rejected',
      'noLabel',
      'missing',
      'single',
      'unrestorable',
      'reserved',
      'unquotable',
      'failed',
    ] as const) {
      expect(syncMessage({ state, name: 'hosts' })).toMatchObject({ problem: true });
    }
    expect(syncMessage({ state: 'changed', name: 'hosts' })?.text).toBe(
      '$hosts was changed and no longer holds the selection'
    );
    expect(syncMessage({ state: 'partial', name: 'hosts', kept: 1, of: 2 })).toEqual({
      text: '$hosts holds only 1 of the 2 selected values',
      problem: true,
    });
    expect(syncMessage({ state: 'partial', name: 'hosts', kept: 0, of: 2 })?.text).toBe(
      '$hosts holds none of the selected values'
    );
    expect(syncMessage({ state: 'single', name: 'hosts' })?.text).toContain('takes one value');
    expect(syncMessage({ state: 'noLabel', name: 'hosts' })?.text).toBe('Set "Selection label" to sync to $hosts');
    expect(syncMessage({ state: 'unsupported', name: 'f', type: 'adhoc' })?.text).toContain('adhoc');
    expect(syncMessage({ state: 'tooLarge', name: 'hosts', length: 7000 })?.text).toContain('7000 of 6000');
  });
});
