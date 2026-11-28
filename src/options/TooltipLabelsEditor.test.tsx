import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FieldType, StandardEditorProps, toDataFrame } from '@grafana/data';
import { TooltipLabelsEditor } from './TooltipLabelsEditor';

const frame = toDataFrame({
  refId: 'A',
  fields: [
    { name: 'zone', type: FieldType.string, values: ['zone-a'] },
    { name: 'partition', type: FieldType.string, values: ['batch'] },
    { name: 'value', type: FieldType.number, values: [1] },
  ],
});

// The edge query of the flow overlay: its labels name the two ends of an edge, not a cell.
const edgeFrame = toDataFrame({
  refId: 'E',
  fields: [
    { name: 'src_host', type: FieldType.string, values: ['node-a1'] },
    { name: 'dst_host', type: FieldType.string, values: ['node-a2'] },
    { name: 'loss', type: FieldType.number, values: [1] },
  ],
});

function editorProps(value: string[], onChange: (value?: string[]) => void): StandardEditorProps<string[]> {
  return { value, onChange, context: { data: [frame] }, item: { id: 'tooltipLabels', name: 'tooltipLabels' } };
}

describe('TooltipLabelsEditor', () => {
  it('adds, edits, and removes label rows', () => {
    const onChange = jest.fn();
    render(<TooltipLabelsEditor {...editorProps([], onChange)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
    expect(onChange).toHaveBeenLastCalledWith(['']);
  });

  it('shows label suggestions from table frames and edits a row', () => {
    function Stateful() {
      const [value, setValue] = React.useState(['zone']);
      return <TooltipLabelsEditor {...editorProps(value, (next) => setValue(next ?? []))} />;
    }
    render(<Stateful />);

    expect(screen.getByText('Available labels: partition, zone')).toBeInTheDocument();
    expect(document.querySelector('datalist option[value="partition"]')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Label name 1'), { target: { value: 'partition' } });
    expect(screen.getByLabelText('Label name 1')).toHaveValue('partition');
    fireEvent.click(screen.getByRole('button', { name: 'Remove label' }));
    expect(screen.queryByLabelText('Label name 1')).not.toBeInTheDocument();
  });

  it('does not offer the labels of the flow overlay edge query', () => {
    const withEdges = {
      ...editorProps([], jest.fn()),
      context: { data: [frame, edgeFrame], options: { flowRefId: 'E' } },
    };
    const view = render(<TooltipLabelsEditor {...withEdges} />);
    expect(screen.getByText('Available labels: partition, zone')).toBeInTheDocument();
    view.unmount();
    // Without an edge query, query E is an ordinary query and its labels are offered as before.
    render(<TooltipLabelsEditor {...withEdges} context={{ data: [frame, edgeFrame], options: {} }} />);
    expect(screen.getByText('Available labels: dst_host, partition, src_host, zone')).toBeInTheDocument();
  });
});
