import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FieldType, StandardEditorProps, toDataFrame } from '@grafana/data';
import { CategoryLabelEditor } from './CategoryLabelEditor';

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

const props = (value: string, onChange: (value?: string) => void): StandardEditorProps<string> => ({
  value,
  onChange,
  context: { data: [frame] },
  item: { id: 'categoryLabel', name: 'categoryLabel' },
});

describe('CategoryLabelEditor', () => {
  it('edits the label and provides label-name suggestions', () => {
    const onChange = jest.fn();
    render(<CategoryLabelEditor {...props('', onChange)} />);

    fireEvent.change(screen.getByLabelText('Category label'), { target: { value: 'partition' } });

    expect(onChange).toHaveBeenCalledWith('partition');
    expect(screen.getByText('Available labels: partition, zone')).toBeInTheDocument();
    expect(document.querySelector('datalist option[value="partition"]')).toBeInTheDocument();
  });

  it('does not offer the labels of the flow overlay edge query', () => {
    const withEdges = { ...props('', jest.fn()), context: { data: [frame, edgeFrame], options: { flowRefId: 'E' } } };
    const view = render(<CategoryLabelEditor {...withEdges} />);
    expect(screen.getByText('Available labels: partition, zone')).toBeInTheDocument();
    view.unmount();
    // Without an edge query, query E is an ordinary query and its labels are offered as before.
    render(<CategoryLabelEditor {...withEdges} context={{ data: [frame, edgeFrame], options: {} }} />);
    expect(screen.getByText('Available labels: dst_host, partition, src_host, zone')).toBeInTheDocument();
  });
});
