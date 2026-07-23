import React from 'react';
import { formattedValueToString } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';
import { CellModel } from '../types';
import { MetricInfo } from '../data/display';
import { cellRangeFor } from '../data/cellRange';
import { formatRangeEndpoint, rangeStateLabel } from './RangeLegend';
import { placeOverlay } from './overlay';

export interface CellTooltipProps {
  cell: CellModel;
  metricInfos: MetricInfo[];
  missingColor: string;
  x: number;
  y: number;
  minX?: number;
  minY?: number;
  maxX?: number;
  maxY?: number;
}

const MAX_W = 320;

export const CellTooltip: React.FC<CellTooltipProps> = ({ cell, metricInfos, missingColor, x, y, ...bounds }) => {
  const theme = useTheme2();
  const labels = Object.entries(cell.labels);
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
  const estimatedH =
    labels.length * 18 +
    refIds.reduce((height, refId) => {
      const range = cell.ranges?.get(refId);
      const hasValue = cell.values.get(refId) != null && infoByRef.has(refId);
      return height + 22 + (hasValue ? 20 + (range?.matchers?.length ?? 0) * 18 : 0);
    }, 0);
  const placementH = hasBounds ? Math.min(estimatedH, availableH) : undefined;
  const placement = hasBounds
    ? placeOverlay(x, y, outerW!, placementH!, bounds as Required<typeof bounds>)
    : { left: x + 12, top: y + 12 };
  const outerH = hasBounds ? Math.max(0, bounds.maxY! - placement.top) : undefined;
  const accessibleName =
    labels.length > 0 ? labels.map(([name, value]) => `${name}: ${value}`).join(', ') : 'Cell details';
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
      {refIds.map((refId) => {
        const info = infoByRef.get(refId);
        const v = cell.values.get(refId) ?? null;
        const range = info ? cellRangeFor(cell, info) : undefined;
        const disp = v === null || !range ? null : range.processor(v);
        const cellRange = cell.ranges?.get(refId);
        return (
          <div key={refId} style={{ marginTop: 2 }}>
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
              <span style={{ marginLeft: 'auto' }}>{disp ? formattedValueToString(disp) : 'No data'}</span>
            </div>
            {range && v !== null && (
              <div style={{ marginLeft: 14, color: theme.colors.text.secondary }}>
                <div>
                  <span>{rangeStateLabel(range)}</span>{' '}
                  <span>{`${formatRangeEndpoint(range, range.effectiveMin)}–${formatRangeEndpoint(
                    range,
                    range.effectiveMax
                  )}`}</span>
                </div>
                {cellRange?.source === 'conflict' && <div>Standard range (override conflict)</div>}
                {(!cellRange || cellRange.source === 'standard') && <div>Standard range</div>}
                {cellRange?.source === 'override' &&
                  cellRange.matchers?.map((matcher, index) => (
                    <div key={`${matcher.label}-${index}`} style={{ overflowWrap: 'anywhere' }}>{`${matcher.label} ${
                      matcher.operator === 'exact' ? '=' : '=~'
                    } ${matcher.value}`}</div>
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
