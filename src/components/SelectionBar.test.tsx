import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CellModel } from '../types';
import { SelectionBar, SelectionBarProps } from './SelectionBar';

const cell = (name: string): CellModel => ({ path: [name], labels: { host: name }, values: new Map([['A', 1]]) });

const props = (over: Partial<SelectionBarProps> = {}): SelectionBarProps => ({
  barRef: React.createRef(),
  selected: [cell('node-a001'), cell('node-a002')],
  rest: [cell('node-a003')],
  missingCount: 0,
  label: 'host',
  values: ['node-a001', 'node-a002'],
  valuesFromMissing: 0,
  sync: { state: 'off' },
  refIds: ['A'],
  metricInfos: [],
  onClear: jest.fn(),
  ...over,
});

// Grafana's Button keeps a disabled button with a tooltip focusable (aria-disabled) and drops its click
// handler, so that the tooltip can still say why the button is disabled.
const isDisabled = (button: HTMLElement) =>
  (button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true';

describe('SelectionBar', () => {
  it('names the group, the size of the selection and what each copy button copies', () => {
    render(<SelectionBar {...props()} />);
    expect(screen.getByRole('group', { name: 'Cell selection' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('2 cells selected');
    expect(screen.getByTestId('selection-label')).toHaveTextContent('2 host values:');
    expect(screen.getByRole('button', { name: 'Copy the host values as a regular expression' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copy the host values as a comma-separated list' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Copy the host values as a hostlist such as node-a[001-012]' })
    ).toBeEnabled();
  });

  it('is reachable by script focus only, and its buttons by Tab', () => {
    render(<SelectionBar {...props()} />);
    expect(screen.getByTestId('selection-bar')).toHaveAttribute('tabindex', '-1');
    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveAttribute('tabindex', '-1');
    }
  });

  it('disables the hostlist copy for values the notation cannot express, and keeps the other formats', () => {
    render(<SelectionBar {...props({ values: ['node-a001', 'a,b'] })} />);
    expect(isDisabled(screen.getByTestId('selection-copy-hostlist'))).toBe(true);
    expect(isDisabled(screen.getByTestId('selection-copy-regex'))).toBe(false);
    expect(isDisabled(screen.getByTestId('selection-copy-list'))).toBe(false);
  });

  it('disables the hostlist copy for a value with white space: Slurm and pdsh would split it', () => {
    render(<SelectionBar {...props({ values: ['node-a001', 'node a002'] })} />);
    expect(isDisabled(screen.getByTestId('selection-copy-hostlist'))).toBe(true);
    expect(isDisabled(screen.getByTestId('selection-copy-list'))).toBe(false);
  });

  it('disables every copy when the selected cells have no value for the label', () => {
    render(<SelectionBar {...props({ values: [] })} />);
    expect(screen.getByTestId('selection-label')).toHaveTextContent('0 host values:');
    for (const format of ['regex', 'list', 'hostlist']) {
      expect(isDisabled(screen.getByTestId(`selection-copy-${format}`))).toBe(true);
    }
  });

  it('copies nothing when a disabled copy button is clicked', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    try {
      render(<SelectionBar {...props({ values: [] })} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('selection-copy-list'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      for (const [target, key, descriptor] of [
        [navigator, 'clipboard', clipboard],
        [window, 'isSecureContext', secure],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(target, key, descriptor);
        } else {
          delete (target as unknown as Record<string, unknown>)[key];
        }
      }
    }
  });

  it('shows no label part without a label, and a sync problem as an alert', () => {
    render(<SelectionBar {...props({ label: undefined, values: [], sync: { state: 'missing', name: 'hosts' } })} />);
    expect(screen.queryByTestId('selection-label')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Variable "hosts" is not in this dashboard');
  });

  it('says how many of the values come only from cells that left the data', () => {
    render(<SelectionBar {...props({ missingCount: 1, valuesFromMissing: 1 })} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 cells selected (+1 not in the current data)');
    expect(screen.getByTestId('selection-label')).toHaveTextContent(
      '2 host values (1 from cells not in the current data):'
    );
  });

  it('counts one cell in the singular', () => {
    render(<SelectionBar {...props({ selected: [cell('node-a001')], values: ['node-a001'] })} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 cell selected');
    expect(screen.getByTestId('selection-label')).toHaveTextContent('1 host value:');
  });
});
