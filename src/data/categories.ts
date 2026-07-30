import { CellModel, HierarchyNode } from '../types';

export interface CategoryModel {
  label: string;
  values: string[];
  colorByValue: Map<string, string>;
}

// Plugin-specific fixed cool palette for categorical decoration.
//
// Why not the Grafana theme palette (theme.visualization.palette): the classic
// palette cycles through reds/greens/yellows/oranges — the exact hues the metric
// heatmap already uses to encode magnitude (green→yellow→orange→red). Cycling those
// hues onto every cell's decoration collides with the fill's semantic colors, so the
// category signal fights the magnitude signal and becomes dominant visual noise.
//
// These four cool hues (blue/purple/cyan/magenta) were picked in OKLab space to be
// CVD-separable, sit in a consistent lightness band with adequate contrast, and stay
// hue-orthogonal to the warm heatmap scale, so "which category" never reads as "how hot".
export const CATEGORY_PALETTE = ['#5794F2', '#7E4FD6', '#1EA3B6', '#C2409E'];

// The 5th and later sorted values all collapse to one neutral slate grey ("other").
// Why fold instead of adding more hues: past four categories, extra distinct colors
// erode discriminability faster than they add meaning, so the tail is intentionally
// bucketed rather than paletted.
export const CATEGORY_OVERFLOW_COLOR = '#8E9AAF';

export function primaryCategoryValue(cell: CellModel, label: string): string | undefined {
  return cell.labelValues?.get(label)?.[0];
}

export function buildCategoryModel(root: HierarchyNode, label: string): CategoryModel | undefined {
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
  const colorByValue = new Map(
    sortedValues.map((value, index) => [
      value,
      index < CATEGORY_PALETTE.length ? CATEGORY_PALETTE[index] : CATEGORY_OVERFLOW_COLOR,
    ])
  );
  return { label, values: sortedValues, colorByValue };
}
