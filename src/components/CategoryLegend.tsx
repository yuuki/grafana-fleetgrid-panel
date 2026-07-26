import React from 'react';
import { CategoryModel } from '../data/categories';

const CategoryLegendComponent: React.FC<{ category: CategoryModel }> = ({ category }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
    {category.values.map((value) => (
      <span
        key={value}
        data-testid={`category-legend-${value}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <span
          aria-hidden
          style={{ width: 10, height: 10, background: category.colorByValue.get(value), display: 'inline-block' }}
        />
        <span>{value}</span>
      </span>
    ))}
  </div>
);

export const CategoryLegend = React.memo(CategoryLegendComponent);
