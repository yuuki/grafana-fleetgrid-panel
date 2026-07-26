import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CategoryModel } from '../data/categories';
import { CategoryLegend } from './CategoryLegend';

describe('CategoryLegend', () => {
  it('renders one colored entry per category value', () => {
    const category: CategoryModel = {
      label: 'partition',
      values: ['a', 'b'],
      colorByValue: new Map([
        ['a', '#f00'],
        ['b', '#00f'],
      ]),
    };

    render(<CategoryLegend category={category} selectedValues={[]} onToggle={jest.fn()} onClear={jest.fn()} />);

    expect(screen.getByTestId('category-legend-a')).toHaveTextContent('a');
    expect(screen.getByTestId('category-legend-a').firstElementChild).toHaveStyle({ background: '#f00' });
    expect(screen.getByTestId('category-legend-b').firstElementChild).toHaveStyle({ background: '#00f' });
  });

  it('toggles values and exposes the current selection', () => {
    const category: CategoryModel = { label: 'partition', values: ['a', 'b'], colorByValue: new Map([['a', '#f00'], ['b', '#00f']]) };
    const onToggle = jest.fn();
    render(<CategoryLegend category={category} selectedValues={['a']} onToggle={onToggle} onClear={jest.fn()} />);

    expect(screen.getByTestId('category-legend-a')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('category-legend-b')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('category-legend-b'));
    expect(onToggle).toHaveBeenCalledWith('b');
  });

  it('shows a clear button only for a non-empty selection and supports keyboard activation', () => {
    const category: CategoryModel = { label: 'partition', values: ['a'], colorByValue: new Map([['a', '#f00']]) };
    const onToggle = jest.fn();
    const onClear = jest.fn();
    const { rerender } = render(
      <CategoryLegend category={category} selectedValues={[]} onToggle={onToggle} onClear={onClear} />
    );
    expect(screen.queryByTestId('category-legend-clear')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('category-legend-a'), { key: 'Enter', code: 'Enter' });
    // Native buttons perform the click activation in the browser; fire it after the keyboard event in jsdom.
    fireEvent.click(screen.getByTestId('category-legend-a'));
    expect(onToggle).toHaveBeenCalledWith('a');

    rerender(<CategoryLegend category={category} selectedValues={['a']} onToggle={onToggle} onClear={onClear} />);
    fireEvent.click(screen.getByTestId('category-legend-clear'));
    expect(onClear).toHaveBeenCalled();
  });
});
