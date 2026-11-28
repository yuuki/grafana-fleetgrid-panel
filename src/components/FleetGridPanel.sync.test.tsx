import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { FleetGridPanel } from './FleetGridPanel';
import { SYNC_DELAY_MS, VERIFY_INTERVAL_MS } from './useVariableSync';
import { CONFIRM_MS } from '../selection/variable';
import { CELL, frames, installPointerEvent, LABEL, makeProps, panelUi, power } from '../testing/selectionPanel';

// The sync of a cell selection to a dashboard variable, in the panel. Grafana is a stand-in here: a
// list of variables, a URL write that becomes a variable's value, and a history that tells its
// listeners about the write. The tests act as Grafana or as a user by changing the variables.
// The rules themselves (which variables, what is written, what is put back) are tested without
// React in src/selection/variable.test.ts; the E2E tests run them in a real Grafana.

type MockVariable = {
  name: string;
  type: string;
  multi?: boolean;
  includeAll?: boolean;
  current?: { value?: unknown };
};

const mockGrafana = {
  variables: [] as MockVariable[],
  writes: [] as Array<Record<string, unknown>>,
  listeners: new Set<() => void>(),
  // What Grafana makes of a written value. The default keeps it.
  apply: (variable: MockVariable, value: unknown): void => {
    variable.current = { value };
  },
  partial(query: Record<string, unknown>, replace?: boolean): void {
    expect(replace).toBe(true);
    this.writes.push(query);
    for (const [key, value] of Object.entries(query)) {
      const variable = this.variables.find((v) => `var-${v.name}` === key);
      if (variable) {
        this.apply(variable, value);
      }
    }
    this.listeners.forEach((listener) => listener());
  },
};

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  PanelDataErrorView: () => <div>No data</div>,
  locationService: {
    partial: (query: Record<string, unknown>, replace?: boolean) => mockGrafana.partial(query, replace),
    getHistory: () => ({
      listen: (listener: () => void) => {
        mockGrafana.listeners.add(listener);
        return () => mockGrafana.listeners.delete(listener);
      },
    }),
  },
  getTemplateSrv: () => ({ getVariables: () => mockGrafana.variables }),
}));

jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Sparkline: () => <div data-testid="sparkline" />,
}));

installPointerEvent();

const multi = (value: unknown = '$__all'): MockVariable => ({
  name: 'hosts',
  type: 'custom',
  multi: true,
  current: { value },
});
const valueOf = (name = 'hosts') => mockGrafana.variables.find((v) => v.name === name)?.current?.value;
const setByHand = (value: unknown, name = 'hosts') => {
  mockGrafana.variables.find((v) => v.name === name)!.current = { value };
};
// The options of a panel that syncs its selected hosts to $hosts.
const synced = (options: Record<string, unknown> = {}) => ({
  selectionLabel: 'host',
  selectionVariable: 'hosts',
  ...options,
});
const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms));
// Long enough for the write to happen and to be read back.
const settle = () => wait(SYNC_DELAY_MS + VERIFY_INTERVAL_MS);

beforeEach(() => {
  jest.useFakeTimers();
  mockGrafana.variables = [multi()];
  mockGrafana.writes = [];
  mockGrafana.listeners.clear();
  mockGrafana.apply = (variable, value) => {
    variable.current = { value };
  };
});
afterEach(() => {
  jest.useRealTimers();
});

describe('FleetGridPanel variable sync', () => {
  const ui = panelUi();

  it('writes nothing unless a variable is configured', () => {
    render(<FleetGridPanel {...makeProps(frames(), { selectionLabel: 'host' })} />);
    ui.shiftClick(LABEL.a);
    settle();
    expect(mockGrafana.writes).toEqual([]);
    expect(ui.sync()).toBeUndefined();
  });

  it('writes nothing without a configured label, and says what to set', () => {
    // The label that is chosen automatically depends on the data on screen. Other panels must not be
    // filtered by it.
    render(<FleetGridPanel {...makeProps(frames(), { selectionVariable: 'hosts' })} />);
    ui.shiftClick(LABEL.a);
    expect(ui.label()).toBe('3 host values:');
    settle();
    expect(mockGrafana.writes).toEqual([]);
    expect(ui.sync()).toBe('Set "Selection label" to sync to $hosts');
  });

  it('takes a label that is not a hierarchy level as no label', () => {
    render(<FleetGridPanel {...makeProps(frames(), synced({ selectionLabel: 'partition' }))} />);
    ui.shiftClick(CELL.a1);
    settle();
    expect(mockGrafana.writes).toEqual([]);
    expect(ui.sync()).toBe('Set "Selection label" to sync to $hosts');
  });

  it('writes the selected hosts once the selection has settled and says so after reading them back', () => {
    render(<FleetGridPanel {...makeProps(frames(), synced({ selectionVariable: '$hosts' }))} />);
    // Three quick gestures are one write.
    ui.shiftClick(CELL.a1);
    ui.shiftClick(CELL.a2);
    ui.shiftClick(CELL.b1);
    expect(mockGrafana.writes).toEqual([]);
    wait(SYNC_DELAY_MS);
    expect(mockGrafana.writes).toEqual([{ 'var-hosts': ['node-a001', 'node-a002', 'node-b001'] }]);
    // Written, not read back yet: the bar does not claim that the variable holds the selection.
    expect(ui.sync()).toBe('Writing $hosts…');
    wait(50);
    expect(ui.sync()).toBe('→ $hosts');

    ui.clear();
    wait(SYNC_DELAY_MS);
    expect(valueOf()).toBe('$__all');
    expect(mockGrafana.writes).toHaveLength(2);
  });

  it('writes one regular expression to a text box', () => {
    mockGrafana.variables = [{ name: 'hosts', type: 'textbox', current: { value: '.*' } }];
    render(<FleetGridPanel {...makeProps(frames(), synced())} />);
    ui.shiftClick(CELL.a1);
    ui.shiftClick(CELL.b2);
    settle();
    expect(valueOf()).toBe('^(node-a001|node-b002)$');
    expect(ui.sync()).toBe('→ $hosts');
    ui.clear();
    wait(SYNC_DELAY_MS);
    expect(valueOf()).toBe('.*');
  });

  it.each<[string, MockVariable, string]>([
    [
      'a query variable that takes one value',
      { name: 'hosts', type: 'query', multi: false, current: { value: 'node-a001' } },
      'Variable "hosts" takes one value: sync to a multi-value variable or a text box',
    ],
    [
      'a variable that takes one value and has the All option',
      { name: 'hosts', type: 'custom', multi: false, includeAll: true, current: { value: '$__all' } },
      'Variable "hosts" takes one value: sync to a multi-value variable or a text box',
    ],
    [
      'a constant',
      { name: 'hosts', type: 'constant', current: { value: 'c0' } },
      'Variable "hosts" has the type constant, which cannot hold a selection',
    ],
  ])('writes nothing to %s and says why', (_what, variable, message) => {
    // Grafana does not keep a regular expression in a single-value variable: it puts a query variable
    // back to its first option at the next refresh, and with the All option the data source escapes
    // the expression so that it matches no host.
    mockGrafana.variables = [variable];
    render(<FleetGridPanel {...makeProps(frames(), synced())} />);
    ui.shiftClick(CELL.b1);
    ui.shiftClick(CELL.b2);
    settle();
    expect(ui.sync()).toBe(message);
    ui.clear();
    settle();
    expect(mockGrafana.writes).toEqual([]);
  });

  it('says in the selection bar when the variable does not exist', () => {
    mockGrafana.variables = [];
    render(<FleetGridPanel {...makeProps(frames(), synced())} />);
    ui.shiftClick(CELL.a1);
    settle();
    expect(mockGrafana.writes).toEqual([]);
    expect(ui.sync()).toBe('Variable "hosts" is not in this dashboard');
  });

  it('says so when Grafana throws on the write, and writes nothing after the panel is gone', () => {
    mockGrafana.apply = () => {
      throw new Error('URI malformed');
    };
    const view = render(<FleetGridPanel {...makeProps(frames(), synced())} />);
    ui.shiftClick(CELL.a1);
    settle();
    expect(ui.sync()).toBe('Could not set $hosts');
    mockGrafana.writes = [];
    ui.shiftClick(CELL.a2);
    view.unmount();
    settle();
    expect(mockGrafana.writes).toEqual([]);
  });

  describe('when the data changes', () => {
    it('does not write again when the data refreshes with the same cells', () => {
      const view = render(<FleetGridPanel {...makeProps(frames(), synced())} />);
      ui.shiftClick(CELL.a1);
      settle();
      const next = makeProps(frames(), synced());
      next.data.request.requestId = 'Q2';
      view.rerender(<FleetGridPanel {...next} />);
      settle();
      expect(mockGrafana.writes).toEqual([{ 'var-hosts': ['node-a001'] }]);
    });

    it("writes once when the panel's own query uses the variable it syncs to", () => {
      // The write narrows the panel's data to the selected host, then Grafana refreshes it again and
      // again. The values of a selection are those remembered when the cells were selected, so the
      // narrowed data changes nothing and nothing is written back: no loop.
      const view = render(<FleetGridPanel {...makeProps(frames(), synced())} />);
      ui.shiftClick(CELL.a2);
      settle();
      expect(mockGrafana.writes).toEqual([{ 'var-hosts': ['node-a002'] }]);
      const onlySelected = frames(power.filter(([, host]) => host === 'node-a002'));
      for (let refresh = 0; refresh < 40; refresh++) {
        const next = makeProps(onlySelected, synced());
        next.data.request.requestId = `Q${refresh + 2}`;
        view.rerender(<FleetGridPanel {...next} />);
        wait(500);
      }
      expect(mockGrafana.writes).toHaveLength(1);
      expect(valueOf()).toEqual(['node-a002']);
      expect(ui.count()).toBe('1 cell selected');
      expect(ui.sync()).toBe('→ $hosts');
    });

    it('keeps the selected hosts in the variable when they stop reporting', () => {
      // The nodes went down: that is when the other panels must keep showing them, not every host.
      const view = render(<FleetGridPanel {...makeProps(frames(), synced())} />);
      ui.shiftClick(CELL.b1);
      ui.shiftClick(CELL.b2);
      settle();
      expect(valueOf()).toEqual(['node-b001', 'node-b002']);

      view.rerender(<FleetGridPanel {...makeProps(frames(power.filter(([zone]) => zone === 'zone-a')), synced())} />);
      settle();
      expect(ui.count()).toBe('0 cells selected (+2 not in the current data)');
      expect(ui.label()).toBe('2 host values (2 from cells not in the current data):');
      expect(valueOf()).toEqual(['node-b001', 'node-b002']);
      expect(ui.sync()).toBe('→ $hosts');
      expect(mockGrafana.writes).toHaveLength(1);

      // They come back: still one write.
      view.rerender(<FleetGridPanel {...makeProps(frames(), synced())} />);
      settle();
      expect(mockGrafana.writes).toHaveLength(1);
    });
  });

  describe('when the variable changes', () => {
    it('says so when Grafana puts the variable back at a refresh, and does not write it again', () => {
      // A query variable re-reads its options at a refresh and drops a value that is not among them.
      mockGrafana.variables = [{ name: 'hosts', type: 'query', multi: true, current: { value: ['node-a001'] } }];
      const view = render(<FleetGridPanel {...makeProps(frames(), synced())} />);
      ui.shiftClick(CELL.b1);
      ui.shiftClick(CELL.b2);
      settle();
      expect(ui.sync()).toBe('→ $hosts');

      setByHand(['node-a001']); // Grafana, at the refresh
      const next = makeProps(frames(), synced());
      next.data.request.requestId = 'Q2';
      view.rerender(<FleetGridPanel {...next} />);
      wait(VERIFY_INTERVAL_MS);
      expect(ui.sync()).toBe('$hosts was changed and no longer holds the selection');
      settle();
      expect(mockGrafana.writes).toHaveLength(1);

      // Clear does not "restore" a variable that is no longer the panel's.
      ui.clear();
      settle();
      expect(valueOf()).toEqual(['node-a001']);
      expect(mockGrafana.writes).toHaveLength(1);
    });

    it("notices at once when the URL changes, and takes the user's value as the one to put back", () => {
      render(<FleetGridPanel {...makeProps(frames(), synced())} />);
      ui.shiftClick(CELL.a1);
      settle();
      // The user picks another host in the variable's own picker: Grafana changes the URL.
      setByHand(['node-b009']);
      act(() => mockGrafana.listeners.forEach((listener) => listener()));
      wait(50);
      expect(ui.sync()).toBe('$hosts was changed and no longer holds the selection');

      // A new selection is the user's new decision. It is written, and Clear puts back what the user
      // had picked, not the value from before the first selection.
      ui.shiftClick(CELL.a2);
      settle();
      expect(valueOf()).toEqual(['node-a001', 'node-a002']);
      expect(ui.sync()).toBe('→ $hosts');
      ui.clear();
      wait(SYNC_DELAY_MS);
      expect(valueOf()).toEqual(['node-b009']);
    });

    it('says how much is left when Grafana drops a part of the selection, and Clear puts the old value back', () => {
      // A query variable whose options are the hosts of zone-a: at a refresh it drops node-b001.
      mockGrafana.variables = [{ name: 'hosts', type: 'query', multi: true, current: { value: '$__all' } }];
      const view = render(<FleetGridPanel {...makeProps(frames(), synced())} />);
      ui.shiftClick(CELL.a1);
      ui.shiftClick(CELL.b1);
      settle();
      expect(ui.sync()).toBe('→ $hosts');

      setByHand(['node-a001']); // Grafana, at the refresh
      const next = makeProps(frames(), synced());
      next.data.request.requestId = 'Q2';
      view.rerender(<FleetGridPanel {...next} />);
      wait(VERIFY_INTERVAL_MS);
      expect(ui.sync()).toBe('$hosts holds only 1 of the 2 selected values');
      settle();
      expect(mockGrafana.writes).toHaveLength(1);

      // No selected host stays behind in the variable.
      ui.clear();
      settle();
      expect(valueOf()).toBe('$__all');
      expect(mockGrafana.writes).toEqual([{ 'var-hosts': ['node-a001', 'node-b001'] }, { 'var-hosts': '$__all' }]);
    });

    it('says so and writes nothing more when Grafana makes something else of the write', () => {
      mockGrafana.variables = [{ name: 'hosts', type: 'query', multi: true, current: { value: ['node-a001'] } }];
      // Grafana turns the written value into its first option.
      mockGrafana.apply = (variable) => {
        variable.current = { value: ['node-a000'] };
      };
      render(<FleetGridPanel {...makeProps(frames(), synced())} />);
      ui.shiftClick(CELL.b1);
      wait(SYNC_DELAY_MS + CONFIRM_MS + VERIFY_INTERVAL_MS);
      expect(ui.sync()).toBe('Grafana did not keep the selection in $hosts');
      // The value is not the panel's, so the panel writes nothing over it, also not at Clear.
      ui.clear();
      settle();
      expect(valueOf()).toEqual(['node-a000']);
      expect(mockGrafana.writes).toEqual([{ 'var-hosts': ['node-b001'] }]);
    });
  });

  describe('two panels that sync to the same variable', () => {
    const renderTwo = () => {
      render(
        <>
          <div data-testid="one">
            <FleetGridPanel {...makeProps(frames(), synced())} />
          </div>
          <div data-testid="two">
            <FleetGridPanel {...makeProps(frames(), synced())} id={2} />
          </div>
        </>
      );
      return { one: panelUi(screen.getByTestId('one')), two: panelUi(screen.getByTestId('two')) };
    };

    it('put the union of their selections in the variable and its original value back at the end', () => {
      const { one, two } = renderTwo();
      one.shiftClick(CELL.a1);
      settle();
      two.shiftClick(CELL.b1);
      settle();
      expect(valueOf()).toEqual(['node-a001', 'node-b001']);
      expect(one.sync()).toBe('→ $hosts (with 1 other panel)');
      expect(two.sync()).toBe('→ $hosts (with 1 other panel)');

      // Clearing panel one leaves panel two's host in the variable.
      one.clear();
      settle();
      expect(valueOf()).toEqual(['node-b001']);
      expect(two.sync()).toBe('→ $hosts');

      // Nothing is selected anywhere: the variable is All again, not a host of panel one.
      two.clear();
      settle();
      expect(valueOf()).toBe('$__all');
      expect(mockGrafana.writes).toEqual([
        { 'var-hosts': ['node-a001'] },
        { 'var-hosts': ['node-a001', 'node-b001'] },
        { 'var-hosts': ['node-b001'] },
        { 'var-hosts': '$__all' },
      ]);
    });

    it('tell both panels when the variable is changed', () => {
      const { one, two } = renderTwo();
      one.shiftClick(CELL.a1);
      two.shiftClick(CELL.b1);
      settle();
      setByHand('$__all');
      wait(VERIFY_INTERVAL_MS);
      expect(one.sync()).toBe('$hosts was changed and no longer holds the selection');
      expect(two.sync()).toBe('$hosts was changed and no longer holds the selection');
    });
  });

  describe('when the panel unmounts', () => {
    const select = () => {
      const view = render(<FleetGridPanel {...makeProps(frames(), synced())} />);
      ui.shiftClick(CELL.a1);
      settle();
      expect(valueOf()).toEqual(['node-a001']);
      return view;
    };

    it('puts the variable back on the same page: the selection is gone, so is its filter', () => {
      // Grafana remounts the panel for the panel view or the editor.
      select().unmount();
      expect(valueOf()).toBe('$__all');
    });

    it('does not touch the URL of another page', () => {
      const view = select();
      const writes = mockGrafana.writes.length;
      window.history.pushState({}, '', '/d/other/dashboard');
      try {
        view.unmount();
        expect(mockGrafana.writes).toHaveLength(writes);
      } finally {
        window.history.pushState({}, '', '/');
      }
    });
  });
});
