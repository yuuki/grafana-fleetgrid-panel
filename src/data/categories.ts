import { GrafanaTheme2 } from '@grafana/data';
import { CellModel, HierarchyNode } from '../types';

export interface CategoryModel {
  label: string;
  values: string[];
  colorByValue: Map<string, string>;
}

export function primaryCategoryValue(cell: CellModel, label: string): string | undefined {
  return cell.labelValues?.get(label)?.[0];
}

export function buildCategoryModel(
  root: HierarchyNode,
  label: string,
  theme: GrafanaTheme2
): CategoryModel | undefined {
  const values = new Set<string>();
  const visit = (node: HierarchyNode) => {
    if (node.cell) {
      for (const value of node.cell.labelValues?.get(label) ?? []) {
        values.add(value);
      }
    }
    node.children.forEach(visit);
  };
  visit(root);

  const sortedValues = [...values].sort((a, b) => a.localeCompare(b));
  if (sortedValues.length === 0) {
    return undefined;
  }
  const palette = theme.visualization.palette;
  const colorByValue = new Map(
    sortedValues.map((value, index) => [value, theme.visualization.getColorByName(palette[index % palette.length])])
  );
  return { label, values: sortedValues, colorByValue };
}
