import React from 'react';
import { FieldType, formattedValueToString } from '@grafana/data';
import { Sparkline, useTheme2 } from '@grafana/ui';
import { CellModel } from '../types';
import { MetricInfo } from '../data/display';
import { placeOverlay } from './overlay';

const W = 300;
const ROW_H = 34;

export interface DrilldownPopoverProps {
  cell: CellModel;
  metricInfos: MetricInfo[];
  seriesFor: (refId: string) => {
    frame: import('@grafana/data').DataFrame | null;
    seriesCount: number;
    aggregated: boolean;
  };
  loading: boolean;
  /** Whether the requery for an instant query failed. Shows a failure message on rows with no time series on hand */
  error?: boolean;
  x: number;
  y: number;
  /** The visible range at click time (content coordinates). Used to clamp the flipped placement to both ends of the visible range */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  onClose: () => void;
}

export const DrilldownPopover: React.FC<DrilldownPopoverProps> = (props) => {
  const theme = useTheme2();
  const contentH = 40 + props.metricInfos.length * ROW_H;
  const availableH = Math.max(0, props.maxY - props.minY);
  const popoverH = Math.min(contentH, availableH);
  // Keep the chrome inside even a degenerate visible range; border-box cannot shrink padding or borders below zero by itself.
  const borderWidth = Math.min(1, popoverH / 2);
  const padding = Math.min(8, Math.max(0, (popoverH - borderWidth * 2) / 2));
  // Flip-place near the open side of the cell, clamped to both ends of the visible range (min..max)
  const { left, top } = placeOverlay(props.x, props.y, W, popoverH, props);

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left,
        top,
        width: W,
        maxHeight: `${popoverH}px`,
        overflowY: contentH > popoverH ? 'auto' : undefined,
        boxSizing: 'border-box',
        zIndex: 20,
        padding: `${padding}px`,
        borderRadius: 4,
        background: theme.colors.background.elevated ?? theme.colors.background.secondary,
        border: `${borderWidth}px solid ${theme.colors.border.medium}`,
        boxShadow: theme.shadows.z3,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>{props.cell.path.join(' / ')}</strong>
        <button onClick={props.onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>
          ×
        </button>
      </div>
      {props.metricInfos.map((info) => {
        const v = props.cell.values.get(info.refId) ?? null;
        const disp = v === null ? null : info.processor(v);
        const { frame, seriesCount, aggregated } = props.seriesFor(info.refId);
        const yField = frame?.fields.find((f) => f.type === FieldType.number);
        const xField = frame?.fields.find((f) => f.type === FieldType.time);
        // When aggregated, shows "(aggregating N series)"; when falling back to the first series due to a timestamp mismatch, shows exactly "(showing first of N series)"
        const name =
          seriesCount > 1
            ? aggregated
              ? `${info.name} (aggregating ${seriesCount} series)`
              : `${info.name} (showing first of ${seriesCount} series)`
            : info.name;
        return (
          <div key={info.refId} style={{ display: 'flex', alignItems: 'center', gap: 8, height: ROW_H }}>
            <span style={{ width: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            <span style={{ width: 60, textAlign: 'right' }}>{disp ? formattedValueToString(disp) : 'No data'}</span>
            <span style={{ flex: 1 }}>
              {yField && xField ? (
                <Sparkline width={120} height={ROW_H - 8} sparkline={{ y: yField, x: xField }} theme={theme} />
              ) : props.loading ? (
                <span style={{ opacity: 0.7 }}>Loading…</span>
              ) : props.error ? (
                // Requery failed. Not a permanent error since a data update triggers an automatic retry
                <span style={{ opacity: 0.7, color: theme.colors.warning.text }}>Failed to load time series</span>
              ) : (
                <span style={{ opacity: 0.7 }}>No time series</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
};
