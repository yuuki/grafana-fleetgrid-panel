import React from 'react';
import { render, screen } from '@testing-library/react';
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

    render(<CategoryLegend category={category} />);

    expect(screen.getByTestId('category-legend-a')).toHaveTextContent('a');
    expect(screen.getByTestId('category-legend-a').firstElementChild).toHaveStyle({ background: '#f00' });
    expect(screen.getByTestId('category-legend-b').firstElementChild).toHaveStyle({ background: '#00f' });
  });
});
