import React from 'react';
import { DisplayProcessor, GrafanaTheme2, formattedValueToString } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';
import { CellModel, ZScoreMethod } from '../types';
import { MetricFrameSlice, ZScoreCellStat } from '../data/colorModes';
import { MetricInfo } from '../data/display';
import { DisplayRangeInfo, cellRangeFor } from '../data/cellRange';
import { formatRangeEndpoint, rangeStateLabel } from './RangeLegend';
import { placeOverlay } from './overlay';

export interface CellTooltipProps {
  cell: CellModel;
  metricInfos: MetricInfo[];
  missingColor: string;
  tooltipLabels?: string[];
  x: number;
  y: number;
  minX?: number;
  minY?: number;
  maxX?: number;
  maxY?: number;
  frameSlicesByRef?: Map<string, MetricFrameSlice>;
  cellIndex?: number;
  zScoreMethod?: ZScoreMethod;
  unitOnlyProcessorsByRef?: Map<string, DisplayProcessor>;
}

const MAX_W = 320;

function readSliceNumber(arr: Float64Array | undefined, cellIndex: number | undefined): number | null {
  if (!arr || cellIndex === undefined || cellIndex < 0 || cellIndex >= arr.length) {
    return null;
  }
  const v = arr[cellIndex];
  return Number.isFinite(v) ? v : null;
}

interface TooltipRangeDetailsProps {
  range: DisplayRangeInfo;
  cellRange: ReturnType<NonNullable<CellModel['ranges']>['get']>;
  overridesCellRanges: boolean;
  theme: GrafanaTheme2;
}

const TooltipRangeDetails: React.FC<TooltipRangeDetailsProps> = ({
  range,
  cellRange,
  overridesCellRanges,
  theme,
}) => (
  <div style={{ marginLeft: 14, color: theme.colors.text.secondary }}>
    <div>
      <span>{rangeStateLabel(range)}</span>{' '}
      <span>{`${formatRangeEndpoint(range, range.effectiveMin)}–${formatRangeEndpoint(
        range,
        range.effectiveMax
      )}`}</span>
    </div>
    {!overridesCellRanges && cellRange?.source === 'conflict' && <div>Standard range (override conflict)</div>}
    {!overridesCellRanges && (!cellRange || cellRange.source === 'standard') && <div>Standard range</div>}
    {!overridesCellRanges &&
      cellRange?.source === 'override' &&
      cellRange.matchers?.map((matcher, index) => (
        <div key={`${matcher.label}-${index}`} style={{ overflowWrap: 'anywhere' }}>{`${matcher.label} ${
          matcher.operator === 'exact' ? '=' : '=~'
        } ${matcher.value}`}</div>
      ))}
  </div>
);

interface TooltipSliceContextProps {
  info: MetricInfo | undefined;
  rawValue: number | null;
  baselineValue: number | null;
  zStat: ZScoreCellStat | undefined;
  zScoreMethod: ZScoreMethod;
  spreadProcessor: DisplayProcessor | undefined;
  theme: GrafanaTheme2;
}

const TooltipSliceContext: React.FC<TooltipSliceContextProps> = ({
  info,
  rawValue,
  baselineValue,
  zStat,
  zScoreMethod,
  spreadProcessor,
  theme,
}) => {
  if (!info) {
    return null;
  }
  const formatSpread = spreadProcessor ?? info.processor;
  const groupName = zStat && zStat.groupPath.length > 0 ? zStat.groupPath.join(' / ') : 'fleet';
  return (
    <>
      {rawValue !== null && (
        <div style={{ marginLeft: 14, color: theme.colors.text.secondary }}>
          {`Value: ${formattedValueToString(info.processor(rawValue))}`}
          {baselineValue !== null && ` (prev: ${formattedValueToString(info.processor(baselineValue))})`}
        </div>
      )}
      {zStat && (
        <div style={{ marginLeft: 14, color: theme.colors.text.secondary, overflowWrap: 'anywhere' }}>
          {`Group (${groupName}, n=${zStat.groupSize}): ${
            zScoreMethod === 'median' ? 'median' : 'mean'
          } ${formattedValueToString(info.processor(zStat.center))}, σ ${formattedValueToString(
            formatSpread(zStat.spread)
          )}`}
        </div>
      )}
    </>
  );
};

function resolveTooltipRange(
  cell: CellModel,
  refId: string,
  info: MetricInfo | undefined,
  slice: MetricFrameSlice | undefined
): { range: DisplayRangeInfo | undefined; cellRange: ReturnType<NonNullable<CellModel['ranges']>['get']> } {
  const cellRange = slice?.overridesCellRanges ? undefined : cell.ranges?.get(refId);
  if (slice) {
    // Only genuine override cells keep their per-cell range during scrubbing; conflict cells fall back to slice.rangeInfo.
    const range = slice.overridesCellRanges
      ? slice.rangeInfo
      : cellRange?.source === 'override'
        ? cellRange
        : slice.rangeInfo;
    return { range, cellRange };
  }
  return { range: info ? cellRangeFor(cell, info) : undefined, cellRange };
}

interface TooltipMetricRowProps {
  refId: string;
  cell: CellModel;
  info: MetricInfo | undefined;
  slice: MetricFrameSlice | undefined;
  cellIndex: number | undefined;
  zScoreMethod: ZScoreMethod;
  spreadProcessor: DisplayProcessor | undefined;
  missingColor: string;
  theme: GrafanaTheme2;
}

const TooltipMetricRow: React.FC<TooltipMetricRowProps> = ({
  refId,
  cell,
  info,
  slice,
  cellIndex,
  zScoreMethod,
  spreadProcessor,
  missingColor,
  theme,
}) => {
  const value = slice ? readSliceNumber(slice.values, cellIndex) : (cell.values.get(refId) ?? null);
  const { range, cellRange } = resolveTooltipRange(cell, refId, info, slice);
  const disp = value === null || !range ? null : range.processor(value);
  const rawValue = slice?.rawValues ? readSliceNumber(slice.rawValues, cellIndex) : null;
  const baselineValue = slice?.baselineValues ? readSliceNumber(slice.baselineValues, cellIndex) : null;
  const zStat = cellIndex !== undefined ? slice?.zScoreStats?.[cellIndex] : undefined;

  return (
    <div style={{ marginTop: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 2,
            background: disp?.color ?? missingColor,
            display: 'inline-block',
          }}
        />
        <span>{info?.name ?? refId}</span>
        {slice?.modeLabel && <span style={{ color: theme.colors.text.secondary }}>{slice.modeLabel}</span>}
        <span style={{ marginLeft: 'auto' }}>{disp ? formattedValueToString(disp) : 'No data'}</span>
      </div>
      <TooltipSliceContext
        info={info}
        rawValue={rawValue}
        baselineValue={baselineValue}
        zStat={zStat}
        zScoreMethod={zScoreMethod}
        spreadProcessor={spreadProcessor}
        theme={theme}
      />
      {range && value !== null && (
        <TooltipRangeDetails
          range={range}
          cellRange={cellRange}
          overridesCellRanges={Boolean(slice?.overridesCellRanges)}
          theme={theme}
        />
      )}
    </div>
  );
};

function estimateTooltipHeight(
  labelLines: number,
  refIds: string[],
  cell: CellModel,
  infoByRef: Map<string, MetricInfo>,
  frameSlicesByRef: Map<string, MetricFrameSlice> | undefined,
  cellIndex: number | undefined
): number {
  let height = labelLines * 18;
  for (const refId of refIds) {
    const slice = frameSlicesByRef?.get(refId);
    const range = slice?.overridesCellRanges ? undefined : cell.ranges?.get(refId);
    const hasValue =
      (slice ? readSliceNumber(slice.values, cellIndex) !== null : cell.values.get(refId) != null) &&
      infoByRef.has(refId);
    const hasRawLine = slice?.rawValues ? readSliceNumber(slice.rawValues, cellIndex) !== null : false;
    const hasZStatLine = cellIndex !== undefined && Boolean(slice?.zScoreStats?.[cellIndex]);
    const extraLines = (hasRawLine ? 18 : 0) + (hasZStatLine ? 18 : 0);
    height += 22 + extraLines + (hasValue ? 20 + (range?.matchers?.length ?? 0) * 18 : 0);
  }
  return height;
}

export const CellTooltip: React.FC<CellTooltipProps> = ({
  cell,
  metricInfos,
  missingColor,
  tooltipLabels = [],
  x,
  y,
  frameSlicesByRef,
  cellIndex,
  zScoreMethod = 'mean',
  unitOnlyProcessorsByRef,
  ...bounds
}) => {
  const theme = useTheme2();
  const labels = Object.entries(cell.labels);
  const extraLabels = tooltipLabels
    .map((key) => [key, cell.labelValues?.get(key) ?? []] as const)
    .filter(([, values]) => values.length > 0);
  const infoByRef = new Map(metricInfos.map((info) => [info.refId, info]));
  // Adaptation: since choices are based on model.refIds, a refId with 0 series has no MetricInfo.
  // Prioritize metricInfos order, while also listing refIds that exist only in cell.values (0 series) at the end and showing them as missing.
  const refIds = [
    ...metricInfos.map((info) => info.refId),
    ...[...cell.values.keys()].filter((refId) => !infoByRef.has(refId)),
  ];
  const hasBounds =
    bounds.minX !== undefined &&
    bounds.minY !== undefined &&
    bounds.maxX !== undefined &&
    bounds.maxY !== undefined &&
    bounds.maxX > bounds.minX &&
    bounds.maxY > bounds.minY;
  const availableW = hasBounds ? bounds.maxX! - bounds.minX! : 0;
  const availableH = hasBounds ? bounds.maxY! - bounds.minY! : 0;
  const outerW = hasBounds ? Math.min(MAX_W, availableW) : undefined;
  const estimatedH = estimateTooltipHeight(
    labels.length + extraLabels.length,
    refIds,
    cell,
    infoByRef,
    frameSlicesByRef,
    cellIndex
  );
  const placementH = hasBounds ? Math.min(estimatedH, availableH) : undefined;
  const placement = hasBounds
    ? placeOverlay(x, y, outerW!, placementH!, bounds as Required<typeof bounds>)
    : { left: x + 12, top: y + 12 };
  const outerH = hasBounds ? Math.max(0, bounds.maxY! - placement.top) : undefined;
  const accessibleName =
    [...labels, ...extraLabels].length > 0
      ? [...labels, ...extraLabels]
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join(', ')
      : 'Cell details';
  return (
    <div
      role="tooltip"
      aria-label={accessibleName}
      tabIndex={0}
      onMouseMove={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      style={{
        position: 'absolute',
        left: placement.left,
        top: placement.top,
        width: outerW,
        maxWidth: outerW,
        maxHeight: outerH,
        boxSizing: hasBounds ? 'border-box' : undefined,
        overflowY: hasBounds ? 'auto' : undefined,
        overscrollBehavior: 'contain',
        zIndex: 10,
        pointerEvents: 'auto',
        padding: '6px 8px',
        borderRadius: 3,
        background: theme.colors.background.elevated ?? theme.colors.background.secondary,
        color: theme.colors.text.primary,
        border: `1px solid ${theme.colors.border.medium}`,
        boxShadow: theme.shadows.z3,
        fontSize: 12,
        whiteSpace: 'normal',
      }}
    >
      {labels.map(([name, value]) => (
        <div key={name} style={{ overflowWrap: 'anywhere' }}>{`${name}: ${value}`}</div>
      ))}
      {extraLabels.map(([name, values]) => (
        <div key={name} style={{ overflowWrap: 'anywhere' }}>{`${name}: ${values.join(', ')}`}</div>
      ))}
      {refIds.map((refId) => (
        <TooltipMetricRow
          key={refId}
          refId={refId}
          cell={cell}
          info={infoByRef.get(refId)}
          slice={frameSlicesByRef?.get(refId)}
          cellIndex={cellIndex}
          zScoreMethod={zScoreMethod}
          spreadProcessor={unitOnlyProcessorsByRef?.get(refId)}
          missingColor={missingColor}
          theme={theme}
        />
      ))}
    </div>
  );
};
