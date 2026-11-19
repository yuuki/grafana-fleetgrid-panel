import { PanelPlugin } from '@grafana/data';
import { FleetGridOptions, normalizeCategoryStyle } from './types';
import { FleetGridPanel } from './components/FleetGridPanel';
import { LevelsEditor } from './options/LevelsEditor';
import { ReduceCalcEditor } from './options/ReduceCalcEditor';
import { RangeOverridesEditor } from './options/RangeOverridesEditor';
import { TooltipLabelsEditor } from './options/TooltipLabelsEditor';
import { CategoryLabelEditor } from './options/CategoryLabelEditor';
import { ZScoreGroupEditor } from './options/ZScoreGroupEditor';

// Hosts older than the Auto Grid fit-content API lack this method. Duck-type so
// the plugin still loads; Grafana only offers "Auto fit" when the method exists
// and is called. Do not bump @grafana/data just to type this.
export function declareFitContentSupport(target: object): void {
  const candidate = target as { setFitContentSupport?: (enabled?: boolean) => unknown };
  candidate.setFitContentSupport?.();
}

// useFieldConfig() enables the standard Field settings (Color scheme / Thresholds / Unit / Min-Max / Data Links / Overrides).
// Without this, this plugin's entire color/unit design would not function.
export const plugin = new PanelPlugin<FleetGridOptions>(FleetGridPanel).useFieldConfig().setPanelOptions((builder) =>
  builder
    .addCustomEditor({
      id: 'levels',
      path: 'levels',
      name: 'Hierarchy Levels',
      category: ['Hierarchy'],
      editor: LevelsEditor,
      defaultValue: [],
    })
    .addRadio({
      path: 'displayMode',
      name: 'Display Mode',
      category: ['Display'],
      defaultValue: 'single',
      settings: {
        options: [
          { value: 'single', label: 'Single' },
          { value: 'split', label: 'Split cells' },
        ],
      },
    })
    .addTextInput({
      path: 'defaultMetric',
      name: 'Default Display Metric (refId)',
      category: ['Display'],
      defaultValue: '',
    })
    .addBooleanSwitch({ path: 'showValues', name: 'Show Values', category: ['Display'], defaultValue: true })
    .addCustomEditor({
      id: 'tooltipLabels',
      path: 'tooltipLabels',
      name: 'Extra tooltip labels',
      category: ['Display'],
      editor: TooltipLabelsEditor,
      defaultValue: [],
    })
    .addCustomEditor({
      id: 'categoryLabel',
      path: 'categoryLabel',
      name: 'Category label',
      category: ['Category decoration'],
      editor: CategoryLabelEditor,
      defaultValue: '',
    })
    .addRadio({
      path: 'categoryStyle',
      name: 'Category style',
      category: ['Category decoration'],
      defaultValue: 'strip',
      settings: {
        options: [
          { value: 'strip', label: 'Bottom strip' },
          { value: 'border', label: 'Outline' },
        ],
      },
    })
    .addBooleanSwitch({
      path: 'showCategoryLegend',
      name: 'Show category legend',
      category: ['Category decoration'],
      defaultValue: true,
    })
    .addColorPicker({
      path: 'missingColor',
      name: 'Missing Color',
      category: ['Display'],
      defaultValue: 'rgb(70,70,70)',
    })
    .addSelect({
      path: 'spatialAggregation',
      name: 'Spatial Aggregation',
      description: 'Aggregation applied when multiple series fall into the same cell',
      category: ['Data'],
      defaultValue: 'max',
      settings: {
        options: [
          { value: 'max', label: 'Max' },
          { value: 'mean', label: 'Mean' },
          { value: 'min', label: 'Min' },
          { value: 'sum', label: 'Sum' },
        ],
      },
    })
    .addCustomEditor({
      id: 'reduceCalc',
      path: 'reduceCalc',
      name: 'Calculation',
      description: 'Calculation used to reduce a range query to a current value',
      category: ['Data'],
      editor: ReduceCalcEditor,
      defaultValue: 'lastNotNull',
    })
    .addRadio({
      path: 'colorMode',
      name: 'Coloring mode',
      description: 'Color cells by raw value, temporal delta v(t) - v(t - Δt), or spatial sibling Z-score',
      category: ['Color mode'],
      defaultValue: 'value',
      settings: {
        options: [
          { value: 'value', label: 'Value' },
          { value: 'delta', label: 'Delta (Δt)' },
          { value: 'zscore', label: 'Spatial Z-score' },
        ],
      },
    })
    .addNumberInput({
      path: 'deltaLookbackSec',
      name: 'Delta lookback (seconds)',
      description: 'Lookback offset Δt in seconds (0 uses the previous sample step)',
      category: ['Color mode'],
      defaultValue: 0,
      settings: { min: 0, step: 15 },
      showIf: (opts) => opts.colorMode === 'delta',
    })
    .addCustomEditor({
      id: 'zScoreGroupDepth',
      path: 'zScoreGroupDepth',
      name: 'Z-score sibling group',
      description: 'Hierarchy group within which sibling deviation is calculated',
      category: ['Color mode'],
      editor: ZScoreGroupEditor,
      defaultValue: -1,
      showIf: (opts) => opts.colorMode === 'zscore',
    })
    .addRadio({
      path: 'zScoreMethod',
      name: 'Z-score method',
      description: 'Mean / StdDev or robust Median / MAD estimator',
      category: ['Color mode'],
      defaultValue: 'mean',
      settings: {
        options: [
          { value: 'mean', label: 'Mean / StdDev' },
          { value: 'median', label: 'Median / MAD' },
        ],
      },
      showIf: (opts) => opts.colorMode === 'zscore',
    })
    .addNumberInput({
      path: 'zScoreLimit',
      name: 'Z-score color limit (±σ)',
      description: 'Symmetric diverging color clamp in standard deviations (0 = auto)',
      category: ['Color mode'],
      defaultValue: 3,
      settings: { min: 0, step: 0.5 },
      showIf: (opts) => opts.colorMode === 'zscore',
    })
    .addBooleanSwitch({
      path: 'enablePlayback',
      name: 'Time scrubber',
      description: 'Show timeline scrubber and playback controls in the panel footer for range queries',
      category: ['Time playback'],
      defaultValue: false,
    })
    .addCustomEditor({
      id: 'rangeOverrides',
      path: 'rangeOverrides',
      name: 'Color scale overrides',
      category: ['Color scale overrides'],
      editor: RangeOverridesEditor,
      defaultValue: [],
    })
);

// Persist the categoryStyle migration into the saved model, not just at draw time: the options editor binds
// its radio to the stored value, so a legacy 'topBar' (e.g. in provisioned dashboards) would otherwise leave
// the control unselected. Normalize 'topBar'/unset → 'strip' and carry 'border' over. shouldMigrate opts in
// whenever the stored value isn't already a current one, so it runs even without a plugin version bump.
//
// Levitate currently flags this call as incompatible with @grafana/data 13.x because
// PanelMigrationHandler was rewritten from an interface to a type alias. The runtime
// signature is unchanged; the known false positive is listed in .levignore.js (see #42).
// Do not drop this handler to "fix" CI.
plugin.setMigrationHandler(
  (panel) => ({
    ...panel.options,
    categoryStyle: normalizeCategoryStyle(panel.options?.categoryStyle as string | undefined),
  }),
  (panel) => {
    const style = (panel.options as FleetGridOptions | undefined)?.categoryStyle as string | undefined;
    return style !== 'strip' && style !== 'border';
  }
);

declareFitContentSupport(plugin);
