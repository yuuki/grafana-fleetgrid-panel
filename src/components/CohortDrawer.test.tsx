import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { DisplayValue } from '@grafana/data';
import { CellModel } from '../types';
import { MetricInfo } from '../data/display';
import { CohortDrawer, formatDelta } from './CohortDrawer';

// Grafana's Drawer needs ResizeObserver and IntersectionObserver, which jsdom does not have.
jest.mock('@grafana/ui', () => ({
  ...jest.requireActual('@grafana/ui'),
  Drawer: ({ title, subtitle, children }: any) => (
    <div role="dialog" aria-label={title}>
      <div>{subtitle}</div>
      {children}
    </div>
  ),
}));

const cells = (values: Array<Record<string, number | null>>): CellModel[] =>
  values.map((v, index) => ({ path: [String(index)], labels: {}, values: new Map(Object.entries(v)) }));

const info = (refId: string, name: string, unit: string): MetricInfo =>
  ({
    refId,
    name,
    processor: (value: number): DisplayValue => ({ numeric: value, text: String(value), suffix: ` ${unit}` }),
  }) as unknown as MetricInfo;

const row = (testId: string) =>
  within(screen.getByTestId(testId))
    .getAllByRole('cell')
    .map((c) => c.textContent);

describe('CohortDrawer', () => {
  it('lists every query with both groups, formatted with the unit of the query', () => {
    render(
      <CohortDrawer
        selected={cells([{ A: 300, B: null }])}
        rest={cells([
          { A: 100, B: 40 },
          { A: 200, B: null },
        ])}
        missingCount={0}
        refIds={['A', 'B', 'C']}
        metricInfos={[info('A', 'power', 'W'), info('B', 'temp', '°C')]}
        onClose={jest.fn()}
      />
    );
    expect(screen.getByText('1 selected cell against 2 other cells')).toBeInTheDocument();
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual([
      'power',
      'Selected',
      'Other',
      'temp',
      'Selected',
      'Other',
      // A query that returned no series has no name of its own.
      'C',
      'Selected',
      'Other',
    ]);
    expect(row('cohort-selected-A')).toEqual(['1', '0', '300 W', '300 W', '300 W', '300 W', '+1.00']);
    expect(row('cohort-rest-A')).toEqual(['2', '0', '100 W', '150 W', '195 W', '200 W']);
    // No value on the selected side: nothing to summarize and nothing to compare, and no zeros.
    expect(row('cohort-selected-B')).toEqual(['0', '1', '–', '–', '–', '–', '–']);
    expect(row('cohort-rest-B')).toEqual(['1', '1', '40 °C', '40 °C', '40 °C', '40 °C']);
    expect(row('cohort-selected-C')).toEqual(['0', '1', '–', '–', '–', '–', '–']);
  });

  it('says so when every cell is selected or when selected cells are missing from the data', () => {
    render(
      <CohortDrawer
        selected={cells([{ A: 1 }, { A: 2 }])}
        rest={[]}
        missingCount={3}
        refIds={['A']}
        metricInfos={[info('A', 'power', 'W')]}
        onClose={jest.fn()}
      />
    );
    expect(screen.getByText('2 selected cells against 0 other cells')).toBeInTheDocument();
    expect(screen.getByText(/Every cell is selected/)).toBeInTheDocument();
    expect(screen.getByText('3 selected cells not in the current data: counted on neither side.')).toBeInTheDocument();
    expect(row('cohort-rest-A')).toEqual(['0', '0', '–', '–', '–', '–']);
    expect(screen.getByTestId('cohort-delta-A')).toHaveTextContent('–');
  });
});

describe('formatDelta', () => {
  it('prints the sign, two decimals, and no sign on zero', () => {
    expect(formatDelta(1)).toBe('+1.00');
    expect(formatDelta(-0.256)).toBe('−0.26');
    expect(formatDelta(0)).toBe('0.00');
    expect(formatDelta(-0.004)).toBe('0.00');
    expect(formatDelta(undefined)).toBe('–');
  });
});
