import { PanelPlugin } from '@grafana/data';
import { FleetGridOptions, normalizeCategoryStyle } from './types';
import { FleetGridPanel } from './components/FleetGridPanel';
import { LevelsEditor } from './options/LevelsEditor';
import { ReduceCalcEditor } from './options/ReduceCalcEditor';
import { RangeOverridesEditor } from './options/RangeOverridesEditor';
import { TooltipLabelsEditor } from './options/TooltipLabelsEditor';
import { CategoryLabelEditor } from './options/CategoryLabelEditor';
import { FlowEndpointsEditor } from './options/FlowEndpointsEditor';
import { flowRefId } from './data/edges';

// Hosts older than the Auto Grid fit-content API lack this method. Duck-type so
// the plugin still loads; Grafana only offers "Auto fit" when the method exists
// and is called. Do not bump @grafana/data just to type this.
export function declareFitContentSupport(target: object): void {
  const candidate = target as { setFitContentSupport?: (enabled?: boolean) => unknown };
  candidate.setFitContentSupport?.();
}

// The flow overlay is off until an edge query is named, and its other options stay hidden until then.
const flowEnabled = (options: FleetGridOptions): boolean => flowRefId(options) !== '';

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
    .addCustomEditor({
      id: 'rangeOverrides',
      path: 'rangeOverrides',
      name: 'Color scale overrides',
      category: ['Color scale overrides'],
      editor: RangeOverridesEditor,
      defaultValue: [],
    })
    .addTextInput({
      path: 'flowRefId',
      name: 'Edge query (refId)',
      description:
        'Query whose rows are edges between cells or groups. It is drawn as arcs, not as a cell metric. Empty turns the overlay off',
      category: ['Flow overlay'],
      defaultValue: '',
    })
    .addCustomEditor({
      id: 'flowEndpoints',
      path: 'flowEndpoints',
      name: 'Endpoint labels',
      description: 'The labels of the edge query that name the source and the destination, per hierarchy label',
      category: ['Flow overlay'],
      editor: FlowEndpointsEditor,
      defaultValue: [],
      showIf: flowEnabled,
    })
    .addRadio({
      path: 'flowShow',
      name: 'Show arcs',
      description: 'On hover draws only the arcs of the cell under the pointer',
      category: ['Flow overlay'],
      defaultValue: 'always',
      settings: {
        options: [
          { value: 'always', label: 'Always' },
          { value: 'hover', label: 'On hover' },
        ],
      },
      showIf: flowEnabled,
    })
    .addRadio({
      path: 'flowWorst',
      name: 'Worse values are',
      description: 'Direction of the filter below, and which edges are kept when there are more than can be drawn',
      category: ['Flow overlay'],
      defaultValue: 'high',
      settings: {
        options: [
          { value: 'high', label: 'Higher' },
          { value: 'low', label: 'Lower' },
        ],
      },
      showIf: flowEnabled,
    })
    .addNumberInput({
      path: 'flowThreshold',
      name: 'Only draw edges worse than',
      description: 'Edges whose value is not strictly worse than this are not drawn. Empty draws every edge',
      category: ['Flow overlay'],
      settings: { placeholder: 'No filter' },
      showIf: flowEnabled,
    })
    .addTextInput({
      path: 'flowOrderLabel',
      name: 'Hop number label',
      description: 'Label of the edge query with the position of an edge in an ordered path, such as a ring',
      category: ['Flow overlay'],
      defaultValue: '',
      showIf: flowEnabled,
    })
    .addTextInput({
      path: 'flowPathLabel',
      name: 'Path label',
      description: 'Label of the edge query that names the path an edge belongs to, such as a job',
      category: ['Flow overlay'],
      defaultValue: '',
      showIf: flowEnabled,
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
