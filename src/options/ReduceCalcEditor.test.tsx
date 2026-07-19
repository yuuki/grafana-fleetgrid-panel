import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ReducerID, StandardEditorProps } from '@grafana/data';
import { ReduceCalcEditor } from './ReduceCalcEditor';

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

function calcProps(value: string, onChange: (v?: string) => void): StandardEditorProps<string> {
  return { value, onChange, context: { data: [] }, item: { id: 'reduceCalc', name: 'reduceCalc' } };
}

// Only allow reducers that return a numeric scalar (array-type and boolean-type are excluded).
const ALLOWED = ['lastNotNull', 'last', 'mean', 'min', 'max', 'sum', 'count'];

function openMenu() {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown', code: 'ArrowDown' });
}

describe('ReduceCalcEditor', () => {
  it('offers only the numeric-scalar reducers', () => {
    render(<ReduceCalcEditor {...calcProps(ReducerID.lastNotNull, jest.fn())} />);
    openMenu();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(ALLOWED);
  });

  it('calls onChange with the selected reducer id', () => {
    const onChange = jest.fn();
    render(<ReduceCalcEditor {...calcProps(ReducerID.lastNotNull, onChange)} />);
    openMenu();
    const sumOption = screen.getAllByRole('option').find((o) => o.textContent === 'sum');
    if (!sumOption) {
      throw new Error('sum option not rendered');
    }
    fireEvent.click(sumOption);
    expect(onChange).toHaveBeenCalledWith('sum');
  });
});
