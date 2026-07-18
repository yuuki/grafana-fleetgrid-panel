import { PanelPlugin } from '@grafana/data';
import { ClusterviewOptions } from './types';
import { ClusterviewPanel } from './components/ClusterviewPanel';
import { LevelsEditor } from './options/LevelsEditor';
import { ReduceCalcEditor } from './options/ReduceCalcEditor';

// useFieldConfig() が標準Field設定(Color scheme / Thresholds / Unit / Min-Max / Data Links / Overrides)を
// 有効化する。これがないと本プラグインの配色・単位の全設計が機能しない
export const plugin = new PanelPlugin<ClusterviewOptions>(ClusterviewPanel).useFieldConfig().setPanelOptions((builder) =>
  builder
    .addCustomEditor({
      id: 'levels',
      path: 'levels',
      name: '階層レベル',
      category: ['Hierarchy'],
      editor: LevelsEditor,
      defaultValue: [],
    })
    .addRadio({
      path: 'displayMode',
      name: '表示モード',
      category: ['Display'],
      defaultValue: 'single',
      settings: {
        options: [
          { value: 'single', label: '単一' },
          { value: 'split', label: '分割セル' },
        ],
      },
    })
    .addTextInput({
      path: 'defaultMetric',
      name: '既定の表示メトリクス(refId)',
      category: ['Display'],
      defaultValue: '',
    })
    .addBooleanSwitch({ path: 'showValues', name: '数値表示', category: ['Display'], defaultValue: true })
    .addColorPicker({ path: 'missingColor', name: '欠損色', category: ['Display'], defaultValue: 'rgb(70,70,70)' })
    .addSelect({
      path: 'spatialAggregation',
      name: '空間集約',
      description: '同一セルに複数系列が落ちたときの集約',
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
      description: 'rangeクエリを現在値に畳む計算',
      category: ['Data'],
      editor: ReduceCalcEditor,
      defaultValue: 'lastNotNull',
    })
);
