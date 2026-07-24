import { PanelPlugin } from '@grafana/data';
import { FleetGridOptions } from './types';
import { FleetGridPanel } from './components/FleetGridPanel';
import { LevelsEditor } from './options/LevelsEditor';
import { ReduceCalcEditor } from './options/ReduceCalcEditor';
import { RangeOverridesEditor } from './options/RangeOverridesEditor';
import { TooltipLabelsEditor } from './options/TooltipLabelsEditor';

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
    .addCustomEditor({
      id: 'rangeOverrides',
      path: 'rangeOverrides',
      name: 'Color scale overrides',
      category: ['Color scale overrides'],
      editor: RangeOverridesEditor,
      defaultValue: [],
    })
);
