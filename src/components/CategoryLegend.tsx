import React from 'react';
import { CategoryModel } from '../data/categories';

interface CategoryLegendProps {
  category: CategoryModel;
  selectedValues: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}

const CategoryLegendComponent: React.FC<CategoryLegendProps> = ({ category, selectedValues, onToggle, onClear }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
    {category.values.map((value) => (
      <button
        type="button"
        key={value}
        data-testid={`category-legend-${value}`}
        aria-pressed={selectedValues.includes(value)}
        onClick={() => onToggle(value)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          border: 0,
          padding: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          opacity: selectedValues.length > 0 && !selectedValues.includes(value) ? 0.6 : 1,
        }}
      >
        <span
          aria-hidden
          style={{ width: 10, height: 10, background: category.colorByValue.get(value), display: 'inline-block' }}
        />
        <span>{value}</span>
      </button>
    ))}
    {selectedValues.length > 0 && (
      <button
        type="button"
        data-testid="category-legend-clear"
        onClick={onClear}
        style={{ border: 0, padding: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' }}
      >
        Clear
      </button>
    )}
  </div>
);

export const CategoryLegend = React.memo(CategoryLegendComponent);
