import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DataFrame, FieldType, StandardEditorProps, toDataFrame } from '@grafana/data';
import { RangeOverride } from '../types';
import { compileRangeOverrides } from '../data/rangeOverrides';
import { collectRangeOverrideSuggestions, RangeOverridesEditor, validateRangeOverride } from './RangeOverridesEditor';

Object.defineProperty(global, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: jest.fn(() => ({
    observe: jest.fn(),
    unobserve: jest.fn(),
    disconnect: jest.fn(),
    takeRecords: jest.fn(() => []),
  })),
});

const timeSeries = toDataFrame({
  refId: 'A',
  fields: [
    { name: 'Time', type: FieldType.time, values: [1] },
    { name: 'power', type: FieldType.number, values: [10], labels: { zone: 'zone-a', bw_type: 'NVLink RX' } },
    { name: 'power', type: FieldType.number, values: [20], labels: { zone: 'zone-b', bw_type: 'NVLink TX' } },
  ],
});

const table = toDataFrame({
  refId: 'B',
  fields: [
    { name: 'zone', type: FieldType.string, values: ['zone-b', 'zone-c'] },
    { name: 'pod', type: FieldType.string, values: ['pod-1', 'pod-2'] },
    { name: 'value', type: FieldType.number, values: [1, 2] },
  ],
});

function editorProps(
  value: RangeOverride[] | undefined,
  onChange: (value?: RangeOverride[]) => void,
  frames: DataFrame[] = []
): StandardEditorProps<RangeOverride[]> {
  return {
    value: value as RangeOverride[],
    onChange,
    context: { data: frames },
    item: { id: 'rangeOverrides', name: 'rangeOverrides' },
  };
}

function StatefulEditor({ initial, frames = [] }: { initial: RangeOverride[]; frames?: DataFrame[] }) {
  const [value, setValue] = React.useState(initial);
  return <RangeOverridesEditor {...editorProps(value, (next) => setValue(next ?? []), frames)} />;
}

describe('collectRangeOverrideSuggestions', () => {
  it('deduplicates refIds, time-series labels, table columns, and sample values', () => {
    expect(collectRangeOverrideSuggestions([timeSeries, table])).toEqual({
      refIds: ['A', 'B'],
      valuesByLabel: {
        bw_type: ['NVLink RX', 'NVLink TX'],
        pod: ['pod-1', 'pod-2'],
        zone: ['zone-a', 'zone-b', 'zone-c'],
      },
    });
  });

  it('caps collected sample values per label while retaining the label', () => {
    const values = Array.from({ length: 25 }, (_, index) => `zone-${String(index).padStart(2, '0')}`);
    const frame = toDataFrame({
      refId: 'C',
      fields: [
        { name: 'zone', type: FieldType.string, values },
        { name: 'value', type: FieldType.number, values: values.map((_, index) => index) },
      ],
    });

    const suggestions = collectRangeOverrideSuggestions([frame]);

    expect(Object.keys(suggestions.valuesByLabel)).toContain('zone');
    expect(suggestions.valuesByLabel.zone).toHaveLength(20);
    expect(suggestions.valuesByLabel.zone).toEqual(values.slice(0, 20));
  });
});

describe('validateRangeOverride', () => {
  const matcher = { label: 'zone', operator: 'exact' as const, value: 'zone-a' };

  it('accepts min-only and max-only rules', () => {
    expect(validateRangeOverride({ matchers: [matcher], min: 0 })).toEqual([]);
    expect(validateRangeOverride({ matchers: [matcher], max: 700 })).toEqual([]);
  });

  it.each([42, null, { query: 'A' }])('rejects a defined non-string refId: %p', (refId) => {
    expect(validateRangeOverride({ refId, matchers: [matcher], max: 700 })).toContain('Metric refId must be a string.');
  });

  it('accepts a whitespace-only refId as all metrics and rejects a whitespace-only label', () => {
    expect(validateRangeOverride({ refId: '   ', matchers: [matcher], max: 700 })).toEqual([]);
    expect(validateRangeOverride({ matchers: [{ ...matcher, label: '   ' }], max: 700 })).toContain(
      'Label name is required.'
    );
  });

  it.each([
    [{ matchers: [], max: 1 }, 'Add at least one label condition.'],
    [{ matchers: [{ ...matcher, label: '' }], max: 1 }, 'Label name is required.'],
    [{ matchers: [{ ...matcher, operator: 'regex', value: '[' }], max: 1 }, 'Invalid regular expression.'],
    [{ matchers: [{ ...matcher, operator: 'contains' }], max: 1 }, 'Operator must be exact or regex.'],
    [{ matchers: [matcher] }, 'Set min or max.'],
    [{ matchers: [matcher], min: Number.POSITIVE_INFINITY }, 'Min must be a finite number.'],
    [{ matchers: [matcher], max: Number.NaN }, 'Max must be a finite number.'],
    [{ matchers: [matcher], min: 2, max: 2 }, 'Min must be less than max.'],
  ])('reports malformed rules inline', (rule, message) => {
    expect(validateRangeOverride(rule as RangeOverride)).toContain(message);
  });
});

describe('RangeOverridesEditor', () => {
  const first: RangeOverride = {
    refId: 'A',
    matchers: [{ label: 'zone', operator: 'exact', value: 'zone-a' }],
    min: 0,
    max: 700,
  };
  const second: RangeOverride = {
    matchers: [{ label: 'pod', operator: 'regex', value: '^pod-' }],
    max: 900,
  };

  it('adds, deletes, and reorders rules', () => {
    const onChange = jest.fn();
    const { rerender } = render(<RangeOverridesEditor {...editorProps([], onChange)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add override' }));
    expect(onChange).toHaveBeenLastCalledWith([
      { matchers: [{ label: '', operator: 'exact', value: '' }], max: undefined, min: undefined },
    ]);

    rerender(<RangeOverridesEditor {...editorProps([first, second], onChange)} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Move override down' })[0]);
    expect(onChange).toHaveBeenLastCalledWith([second, first]);

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete override' })[0]);
    expect(onChange).toHaveBeenLastCalledWith([second]);
  });

  it('adds and deletes matchers while keeping at least one condition', () => {
    const onChange = jest.fn();
    const { rerender } = render(<RangeOverridesEditor {...editorProps([first], onChange)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...first, matchers: [...first.matchers, { label: '', operator: 'exact', value: '' }] },
    ]);

    rerender(
      <RangeOverridesEditor
        {...editorProps([{ ...first, matchers: [...first.matchers, second.matchers[0]] }], onChange)}
      />
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete condition' })[0]);
    expect(onChange).toHaveBeenLastCalledWith([{ ...first, matchers: [second.matchers[0]] }]);

    rerender(<RangeOverridesEditor {...editorProps([first], onChange)} />);
    expect(screen.getByRole('button', { name: 'Delete condition' })).toBeDisabled();
  });

  it('edits matcher fields, optional numeric endpoints, and preserves zero', () => {
    const onChange = jest.fn();
    render(<RangeOverridesEditor {...editorProps([first], onChange, [timeSeries, table])} />);
    const rule = screen.getByTestId('range-override-0');

    fireEvent.change(within(rule).getByLabelText('Match value'), { target: { value: 'zone-c' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...first, matchers: [{ ...first.matchers[0], value: 'zone-c' }] }]);

    fireEvent.change(within(rule).getByLabelText('Minimum'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...first, min: undefined }]);

    fireEvent.change(within(rule).getByLabelText('Maximum'), { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...first, max: 0 }]);
  });

  it('does not associate validation with valid exact or regex values', () => {
    render(<RangeOverridesEditor {...editorProps([first, second], jest.fn())} />);

    for (const input of screen.getAllByLabelText('Match value')) {
      expect(input).not.toHaveAttribute('aria-invalid', 'true');
      expect(input).not.toHaveAttribute('aria-describedby');
    }
  });

  it('does not present a persisted non-string refId as all metrics and associates its validation', () => {
    const malformed = { ...first, refId: null } as unknown as RangeOverride;
    const onChange = jest.fn();
    render(<RangeOverridesEditor {...editorProps([malformed], onChange)} />);

    expect(screen.queryByText('All metrics')).not.toBeInTheDocument();
    expect(screen.getByText('Metric refId must be a string.')).toBeInTheDocument();
    const refIdInput = screen.getByLabelText('Metric refId');
    expect(refIdInput).toHaveValue('');
    expect(refIdInput).toHaveAttribute('aria-invalid', 'true');
    const validationId = refIdInput.getAttribute('aria-describedby');
    expect(document.getElementById(validationId as string)).toHaveTextContent('Metric refId must be a string.');

    fireEvent.change(screen.getByLabelText('Match value'), { target: { value: 'zone-b' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { ...first, refId: null, matchers: [{ ...first.matchers[0], value: 'zone-b' }] },
    ]);
  });

  it('shows refId, label, and value suggestions while allowing custom values and all metrics', () => {
    render(<StatefulEditor initial={[first]} frames={[timeSeries, table]} />);
    expect(screen.getByPlaceholderText('All metrics')).toBeInTheDocument();
    expect(screen.getByText('Available refIds: A, B')).toBeInTheDocument();
    expect(screen.getByText('Available labels: bw_type, pod, zone')).toBeInTheDocument();
    expect(screen.getByText('Sample values: zone-a, zone-b, zone-c')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Metric refId'), { target: { value: 'custom-query' } });
    expect(screen.getByLabelText('Metric refId')).toHaveValue('custom-query');
    fireEvent.change(screen.getByLabelText('Metric refId'), { target: { value: '' } });
    expect(screen.getByLabelText('Metric refId')).toHaveValue('');
    expect(screen.getByText('All metrics')).toBeInTheDocument();
  });

  it('updates label and operator and displays validation without crashing on persisted malformed values', () => {
    const malformed = {
      matchers: [null, { label: '', operator: 'regex', value: '[' }],
      min: Number.POSITIVE_INFINITY,
    } as unknown as RangeOverride;
    render(<StatefulEditor initial={[malformed]} frames={[timeSeries]} />);

    expect(screen.getByText('Invalid regular expression.')).toBeInTheDocument();
    expect(screen.getByText('Min must be a finite number.')).toBeInTheDocument();
    const invalidRegexInput = screen.getAllByLabelText('Match value')[1];
    expect(invalidRegexInput).toHaveAttribute('aria-invalid', 'true');
    const validationId = invalidRegexInput.getAttribute('aria-describedby');
    expect(validationId).toBeTruthy();
    expect(document.getElementById(validationId as string)).toHaveTextContent('Invalid regular expression.');

    fireEvent.change(screen.getAllByLabelText('Label name')[0], { target: { value: 'custom_label' } });
    expect(screen.getAllByLabelText('Label name')[0]).toHaveValue('custom_label');
    fireEvent.click(within(screen.getAllByLabelText('Operator')[0]).getByText('Regex'));
    expect(within(screen.getAllByLabelText('Operator')[0]).getAllByRole('radio')[1]).toBeChecked();
  });

  it('preserves invalid operators and malformed siblings until the targeted field is repaired', () => {
    const invalidOperator = { label: 'zone', operator: 'contains', value: 'zone-a' };
    const malformedSibling = { matchers: [null], max: 900 };
    const persisted = [
      { refId: 'A', matchers: [invalidOperator], max: 700 },
      malformedSibling,
    ] as unknown as RangeOverride[];
    const onChange = jest.fn();
    const { rerender } = render(<RangeOverridesEditor {...editorProps(persisted, onChange)} />);

    expect(screen.getByText('Operator must be exact or regex.')).toBeInTheDocument();
    const operatorGroup = screen.getAllByLabelText('Operator')[0];
    expect(within(operatorGroup).getAllByRole('radio')[0]).not.toBeChecked();
    expect(within(operatorGroup).getAllByRole('radio')[1]).not.toBeChecked();

    fireEvent.change(screen.getAllByLabelText('Metric refId')[0], { target: { value: 'custom' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { refId: 'custom', matchers: [invalidOperator], max: 700 },
      malformedSibling,
    ]);
    const savedRules = onChange.mock.lastCall?.[0] as RangeOverride[];
    expect(compileRangeOverrides([savedRules[0]])).toEqual([]);

    rerender(<RangeOverridesEditor {...editorProps(persisted, onChange)} />);
    fireEvent.click(within(screen.getAllByLabelText('Operator')[0]).getByText('Regex'));
    expect(onChange).toHaveBeenLastCalledWith([
      { refId: 'A', matchers: [{ ...invalidOperator, operator: 'regex' }], max: 700 },
      malformedSibling,
    ]);
  });

  it('memoizes suggestions while editor values change', () => {
    let iterations = 0;
    const values = {
      length: 1,
      get: () => 'zone-a',
      toArray: () => ['zone-a'],
      [Symbol.iterator]: function* () {
        iterations += 1;
        yield 'zone-a';
      },
    };
    const frame = {
      refId: 'A',
      length: 1,
      fields: [
        { name: 'zone', type: FieldType.string, values },
        { name: 'value', type: FieldType.number, values: [1] },
      ],
    } as unknown as DataFrame;

    render(<StatefulEditor initial={[first]} frames={[frame]} />);
    expect(iterations).toBe(1);
    fireEvent.change(screen.getByLabelText('Metric refId'), { target: { value: 'custom' } });
    expect(iterations).toBe(1);
  });

  it('uses unique datalist ids for multiple editor instances', () => {
    render(
      <>
        <RangeOverridesEditor {...editorProps([first], jest.fn(), [timeSeries])} />
        <RangeOverridesEditor {...editorProps([first], jest.fn(), [timeSeries])} />
      </>
    );
    const refIdInputs = screen.getAllByLabelText('Metric refId');
    expect(refIdInputs[0].getAttribute('list')).not.toBe(refIdInputs[1].getAttribute('list'));
  });

  it('deletes the currently first rule after a stateful reorder', () => {
    render(<StatefulEditor initial={[first, { ...second, refId: 'B' }]} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Move override down' })[0]);
    expect(screen.getAllByLabelText('Metric refId').map((input) => input.getAttribute('value'))).toEqual(['B', 'A']);

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete override' })[0]);
    expect(screen.getByLabelText('Metric refId')).toHaveValue('A');
  });

  it.each([null, undefined])(
    'normalizes a persisted %s rule so it can be validated, edited, and deleted',
    (persistedRule) => {
      const onChange = jest.fn();
      render(
        <RangeOverridesEditor {...editorProps([persistedRule] as unknown as RangeOverride[], onChange, [timeSeries])} />
      );

      expect(screen.getByText('Label name is required.')).toBeInTheDocument();
      expect(screen.getByText('Set min or max.')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Label name'), { target: { value: 'zone' } });
      expect(onChange).toHaveBeenLastCalledWith([
        {
          matchers: [{ label: 'zone', operator: 'exact', value: '' }],
          min: undefined,
          max: undefined,
        },
      ]);

      fireEvent.click(screen.getByRole('button', { name: 'Delete override' }));
      expect(onChange).toHaveBeenLastCalledWith([]);
    }
  );
});
