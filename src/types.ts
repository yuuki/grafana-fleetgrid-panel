export type ExtractPreset = 'raw' | 'trailingNumber' | 'regex';
export type SortOrder = 'natural' | 'naturalDesc' | 'none';
export type LevelLayout = 'vertical' | 'horizontal' | 'flow' | 'grid';
export type SpatialAggregation = 'max' | 'mean' | 'min' | 'sum';
export type DisplayMode = 'single' | 'split';

export interface LevelDef {
  label: string;
  extract: ExtractPreset;
  regex?: string;
  sort: SortOrder;
  layout: LevelLayout;
  gridColumns?: number;
  showBorder: boolean;
  showLabel: boolean;
}

export interface ClusterviewOptions {
  levels: LevelDef[];
  displayMode: DisplayMode;
  defaultMetric?: string;
  showValues: boolean;
  missingColor: string;
  spatialAggregation: SpatialAggregation;
  /** ReducerID (e.g. 'lastNotNull') — 時間方向reduce */
  reduceCalc: string;
}

export const DEFAULT_LEVEL: LevelDef = {
  label: '',
  extract: 'raw',
  sort: 'natural',
  layout: 'flow',
  showBorder: false,
  showLabel: true,
};

export interface NormalizedRow {
  labels: Record<string, string>;
  value: number | null;
  refId: string;
}

export interface CellModel {
  path: string[];
  /** 階層に使ったラベルキーの代表原値(ドリルダウンの系列特定に使う) */
  labels: Record<string, string>;
  values: Map<string, number | null>;
}

export interface HierarchyNode {
  key: string;
  path: string[];
  children: HierarchyNode[];
  cell?: CellModel;
}
