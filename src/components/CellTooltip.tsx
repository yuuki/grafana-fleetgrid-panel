import React from 'react';
import { formattedValueToString } from '@grafana/data';
import { CellModel } from '../types';
import { MetricInfo } from '../data/display';

export interface CellTooltipProps {
  cell: CellModel;
  metricInfos: MetricInfo[];
  missingColor: string;
  x: number;
  y: number;
}

export const CellTooltip: React.FC<CellTooltipProps> = ({ cell, metricInfos, missingColor, x, y }) => {
  const infoByRef = new Map(metricInfos.map((info) => [info.refId, info]));
  // Adaptation: since choices are based on model.refIds, a refId with 0 series has no MetricInfo.
  // Prioritize metricInfos order, while also listing refIds that exist only in cell.values (0 series) at the end and showing them as missing.
  const refIds = [
    ...metricInfos.map((info) => info.refId),
    ...[...cell.values.keys()].filter((refId) => !infoByRef.has(refId)),
  ];
  return (
    <div
      style={{
        position: 'absolute',
        left: x + 12,
        top: y + 12,
        zIndex: 10,
        pointerEvents: 'none',
        padding: '6px 8px',
        borderRadius: 3,
        background: 'rgba(24,27,31,0.95)',
        color: '#d8d9da',
        fontSize: 12,
        whiteSpace: 'nowrap',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{cell.path.join(' / ')}</div>
      {refIds.map((refId) => {
        const info = infoByRef.get(refId);
        const v = cell.values.get(refId) ?? null;
        const disp = v === null || !info ? null : info.processor(v);
        return (
          <div key={refId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
        );
      })}
    </div>
  );
};
