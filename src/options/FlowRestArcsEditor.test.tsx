import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StandardEditorProps } from '@grafana/data';
import { FlowRestArcsEditor } from './FlowRestArcsEditor';

type Props = StandardEditorProps<number | undefined>;

const props = (value: number | undefined, onChange: Props['onChange']): Props => ({
  value,
  onChange,
  context: { data: [] },
  item: { id: 'flowRestArcs', name: 'Arcs at rest' } as Props['item'],
});

// Types into the field and leaves it, as a user does.
function type(text: string) {
  const input = screen.getByLabelText('Arcs at rest');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
  return input;
}

describe('FlowRestArcsEditor', () => {
  it('shows the stored number, or the default when none is stored', () => {
    const view = render(<FlowRestArcsEditor {...props(40, jest.fn())} />);
    expect(screen.getByLabelText('Arcs at rest')).toHaveValue(40);
    view.unmount();
    render(<FlowRestArcsEditor {...props(undefined, jest.fn())} />);
    expect(screen.getByLabelText('Arcs at rest')).toHaveValue(100);
  });

  it.each([
    ['1000', 500],
    ['0', 1],
    ['-5', 1],
    ['40.6', 41],
    ['250', 250],
    ['', 100],
  ])('stores what it shows: typing %p stores %p', (typed, stored) => {
    const onChange = jest.fn();
    render(<FlowRestArcsEditor {...props(40, onChange)} />);
    type(typed);
    // The value that is stored is the limited one, never the typed one.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(stored);
  });

  it('stores on Enter as well, and nothing when the number did not change', () => {
    const onChange = jest.fn();
    render(<FlowRestArcsEditor {...props(40, onChange)} />);
    const input = screen.getByLabelText('Arcs at rest');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(7);
    type('7');
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(2);
    onChange.mockClear();
    type('40');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the limited number of a value that was stored out of range by hand', () => {
    render(<FlowRestArcsEditor {...props(1000, jest.fn())} />);
    expect(screen.getByLabelText('Arcs at rest')).toHaveValue(500);
  });
});
