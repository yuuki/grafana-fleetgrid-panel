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
});
