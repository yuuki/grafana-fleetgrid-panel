import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StandardEditorProps } from '@grafana/data';
import { DEFAULT_LEVEL, FleetGridOptions } from '../types';
import { SelectionLabelEditor } from './SelectionLabelEditor';

const options = {
  levels: [
    { ...DEFAULT_LEVEL, label: 'zone' },
    { ...DEFAULT_LEVEL, label: 'host' },
    { ...DEFAULT_LEVEL, label: 'gpu' },
  ],
} as FleetGridOptions;

const props = (
  value: string | undefined,
  onChange: (value?: string) => void,
  context: StandardEditorProps<string, unknown, FleetGridOptions>['context'] = { data: [], options }
): StandardEditorProps<string, unknown, FleetGridOptions> => ({
  value: value as string,
  onChange,
  context,
  item: { id: 'selectionLabel', name: 'selectionLabel' },
});

describe('SelectionLabelEditor', () => {
  it('edits the label and suggests the hierarchy labels', () => {
    const onChange = jest.fn();
    render(<SelectionLabelEditor {...props('', onChange)} />);

    expect(screen.getByLabelText('Selection label')).toHaveAttribute('placeholder', 'Automatic');
    fireEvent.change(screen.getByLabelText('Selection label'), { target: { value: 'host' } });

    expect(onChange).toHaveBeenCalledWith('host');
    expect(screen.getByText('Hierarchy labels: zone, host, gpu')).toBeInTheDocument();
    expect(document.querySelectorAll('datalist option')).toHaveLength(3);
  });

  it('marks a label that is not a hierarchy level, which the panel replaces by the automatic choice', () => {
    render(<SelectionLabelEditor {...props('partition', jest.fn())} />);
    expect(screen.getByText('Not a hierarchy label: chosen automatically')).toBeInTheDocument();
  });

  it('accepts a hierarchy label and an unset value without a remark', () => {
    const first = render(<SelectionLabelEditor {...props('host', jest.fn())} />);
    expect(screen.queryByText('Not a hierarchy label: chosen automatically')).not.toBeInTheDocument();
    first.unmount();
    // The editor context carries no panel options.
    render(<SelectionLabelEditor {...props(undefined, jest.fn(), { data: [] })} />);
    expect(screen.getByLabelText('Selection label')).toHaveValue('');
    expect(screen.getByText('Hierarchy labels: None')).toBeInTheDocument();
  });
});
