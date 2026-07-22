import { MetricInfo } from './display';
import { CellModel, CellRangeInfo } from '../types';

export type DisplayRangeInfo = Pick<
  CellRangeInfo,
  'effectiveMin' | 'effectiveMax' | 'minConfigured' | 'maxConfigured' | 'processor'
>;

export const cellRangeFor = (cell: CellModel, metricInfo: MetricInfo): DisplayRangeInfo & Partial<CellRangeInfo> =>
  cell.ranges?.get(metricInfo.refId) ?? metricInfo;

export const rangeSignature = (range: DisplayRangeInfo): string =>
  `${range.effectiveMin}\0${range.effectiveMax}\0${range.minConfigured}\0${range.maxConfigured}`;
