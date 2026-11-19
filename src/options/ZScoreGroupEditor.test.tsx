import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_LEVEL, FleetGridOptions } from '../types';
import { ZScoreGroupEditor } from './ZScoreGroupEditor';

// jsdom lacks IntersectionObserver, which @grafana/ui's Select menu (ScrollIndicators) requires.
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

describe('ZScoreGroupEditor', () => {
  it('lists parent group, entire fleet, and non-leaf hierarchy levels', () => {
    const onChange = jest.fn();
    const options: Partial<FleetGridOptions> = {
      levels: [
        { ...DEFAULT_LEVEL, label: 'zone' },
        { ...DEFAULT_LEVEL, label: 'host' },
        { ...DEFAULT_LEVEL, label: 'gpu' },
      ],
    };
    render(
      <ZScoreGroupEditor
        value={-1}
        onChange={onChange}
        item={{} as never}
        context={{ data: [], options: options as FleetGridOptions } as never}
      />
    );

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    const optionLabels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(optionLabels).toEqual([
      'Parent group (default)',
      'Entire fleet',
      'Within "zone" (level 1)',
      'Within "host" (level 2)',
    ]);

    fireEvent.click(screen.getByText('Within "zone" (level 1)'));
    expect(onChange).toHaveBeenCalledWith(0);
  });
});
