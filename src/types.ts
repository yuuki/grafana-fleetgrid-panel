import type { DisplayProcessor } from '@grafana/data';

export type ExtractPreset = 'raw' | 'trailingNumber' | 'regex';
export type SortOrder = 'natural' | 'naturalDesc' | 'none';
export type LevelLayout = 'vertical' | 'horizontal' | 'flow' | 'grid';
export type SpatialAggregation = 'max' | 'mean' | 'min' | 'sum';
export type DisplayMode = 'single' | 'split';
export type RangeMatcherOperator = 'exact' | 'regex';
export type CategoryDecorationStyle = 'border' | 'topBar';

export interface RangeMatcher {
  label: string;
  operator: RangeMatcherOperator;
  value: string;
}

export interface RangeOverride {
  refId?: string;
  matchers: RangeMatcher[];
  min?: number;
  max?: number;
}

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

export interface FleetGridOptions {
  levels: LevelDef[];
  displayMode: DisplayMode;
  defaultMetric?: string;
  showValues: boolean;
  /** Extra label names, e.g. 'partition', listed in the cell tooltip. */
  tooltipLabels?: string[];
  /** Label whose values drive categorical cell decoration. Empty or unset disables it. */
  categoryLabel?: string;
  /** Visual style for categorical cell decoration. */
  categoryStyle?: CategoryDecorationStyle;
  /** Whether to show the categorical legend. */
  showCategoryLegend?: boolean;
  missingColor: string;
  spatialAggregation: SpatialAggregation;
  /** ReducerID (e.g. 'lastNotNull') — reduce along the time axis */
  reduceCalc: string;
  /** Ordered color scale overrides. The first rule matching a source label set wins. */
  rangeOverrides?: RangeOverride[];
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
  /** The representative original value of the label key used for the hierarchy (for display/backward compatibility; matches the first labelSet) */
  labels: Record<string, string>;
  /**
   * All original label sets collapsed into this cell. Holds every distinct original value whose
   * extraction key collides (e.g. both node-a017 and node-b017 mapping to "017"), so drilldown
   * can search the same series set as the cell value.
   * Always set on the production path (attachCells). May be omitted for display-only/lightweight fixtures.
   */
  labelSets?: Array<Record<string, string>>;
  /** Distinct values per configured extra tooltip label, including null-valued rows. */
  labelValues?: Map<string, string[]>;
  /** Complete source labels that contributed a non-null value, kept separate per query. */
  sourceLabelSetsByRef?: Map<string, Array<Record<string, string>>>;
  values: Map<string, number | null>;
  /** Effective color range and processor for each metric in this cell. */
  ranges?: Map<string, CellRangeInfo>;
}

export interface CellRangeInfo {
  effectiveMin: number;
  effectiveMax: number;
  minConfigured: boolean;
  maxConfigured: boolean;
  processor: DisplayProcessor;
  source: 'standard' | 'override' | 'conflict';
  matchedRuleIndex?: number;
  matchers?: RangeMatcher[];
}

export interface HierarchyNode {
  key: string;
  path: string[];
  children: HierarchyNode[];
  cell?: CellModel;
}
