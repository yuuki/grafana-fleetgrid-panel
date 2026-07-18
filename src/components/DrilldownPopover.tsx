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
  const h = 40 + props.metricInfos.length * ROW_H;
  // Flip-place near the open side of the cell, clamped to both ends of the visible range (min..max)
  const { left, top } = placeOverlay(props.x, props.y, W, h, props);

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left,
        top,
        width: W,
        zIndex: 20,
        padding: 8,
        borderRadius: 4,
        background: theme.colors.background.elevated ?? theme.colors.background.secondary,
        border: `1px solid ${theme.colors.border.medium}`,
        boxShadow: theme.shadows.z3,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>{props.cell.path.join(' / ')}</strong>
        <button onClick={props.onClose} aria-label="閉じる" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>
          ×
        </button>
      </div>
      {props.metricInfos.map((info) => {
        const v = props.cell.values.get(info.refId) ?? null;
        const disp = v === null ? null : info.processor(v);
        const { frame, seriesCount, aggregated } = props.seriesFor(info.refId);
        const yField = frame?.fields.find((f) => f.type === FieldType.number);
        const xField = frame?.fields.find((f) => f.type === FieldType.time);
        // When aggregated, shows "(N系列を集約)"; when falling back to the first series due to a timestamp mismatch, shows exactly "(N系列中の先頭を表示)"
        const name =
          seriesCount > 1
            ? aggregated
              ? `${info.name} (${seriesCount}系列を集約)`
              : `${info.name} (${seriesCount}系列中の先頭を表示)`
            : info.name;
        return (
          <div key={info.refId} style={{ display: 'flex', alignItems: 'center', gap: 8, height: ROW_H }}>
            <span style={{ width: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            <span style={{ width: 60, textAlign: 'right' }}>{disp ? formattedValueToString(disp) : '欠損'}</span>
            <span style={{ flex: 1 }}>
              {yField && xField ? (
                <Sparkline width={120} height={ROW_H - 8} sparkline={{ y: yField, x: xField }} theme={theme} />
              ) : props.loading ? (
                <span style={{ opacity: 0.7 }}>読み込み中…</span>
              ) : props.error ? (
                // Requery failed. Not a permanent error since a data update triggers an automatic retry
                <span style={{ opacity: 0.7, color: theme.colors.warning.text }}>再取得に失敗しました</span>
              ) : (
                <span style={{ opacity: 0.7 }}>時系列なし</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
};
