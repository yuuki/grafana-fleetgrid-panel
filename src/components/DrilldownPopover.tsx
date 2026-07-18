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
  /** instantクエリの再クエリが失敗したか。手元に時系列が無い行に失敗メッセージを出す */
  error?: boolean;
  x: number;
  y: number;
  /** クリック時点の可視範囲(コンテンツ座標)。反転配置を可視範囲の両端にクランプするのに使う */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  onClose: () => void;
}

export const DrilldownPopover: React.FC<DrilldownPopoverProps> = (props) => {
  const theme = useTheme2();
  const h = 40 + props.metricInfos.length * ROW_H;
  // セル近傍の空いている側に反転配置し、可視範囲(min..max)の両端にクランプする
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
        // 集約時は「N系列を集約」、時刻不一致で先頭系列フォールバック時は正確に「N系列中の先頭を表示」
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
                // 再クエリ失敗。データ更新で自動リトライされるため恒久エラーではない
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
