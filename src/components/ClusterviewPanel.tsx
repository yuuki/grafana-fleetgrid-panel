import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanelProps } from '@grafana/data';
import { PanelDataErrorView } from '@grafana/runtime';
import { RadioButtonGroup, useTheme2 } from '@grafana/ui';
import { CellModel, ClusterviewOptions } from '../types';
import { buildModel } from '../data/model';
import { computeLayout } from '../layout/layout';
import { renderCanvas } from '../render/renderer';
import { hitTest } from '../render/hitTest';
import { CellTooltip } from './CellTooltip';

const HEADER_H = 32;

export const ClusterviewPanel: React.FC<PanelProps<ClusterviewOptions>> = (props) => {
  const { data, width, height, options, timeZone } = props;
  const theme = useTheme2();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [selected, setSelected] = useState<string | undefined>(options.defaultMetric || undefined);
  const [hover, setHover] = useState<{ cell: CellModel; x: number; y: number } | null>(null);

  const targetRefIds = useMemo(
    () => (data.request?.targets ?? []).map((t) => t.refId).filter((r): r is string => Boolean(r)),
    [data.request]
  );
  const model = useMemo(
    () => buildModel(data.series, options, theme, timeZone, targetRefIds),
    [data.series, options, theme, timeZone, targetRefIds]
  );

  // displayModeはTask 14まで未登録のため実行時は undefined になりうる。single を既定に正規化する
  const displayMode = options.displayMode ?? 'single';
  const showHeader = model.refIds.length > 1 && displayMode === 'single';
  const bodyH = height - (showHeader ? HEADER_H : 0);

  const layout = useMemo(
    () => computeLayout(model.root, options.levels, width, bodyH),
    [model.root, options.levels, width, bodyH]
  );

  const selectedRefId = selected && model.refIds.includes(selected) ? selected : model.refIds[0] ?? 'A';

  useEffect(() => {
    if (canvasRef.current) {
      renderCanvas(canvasRef.current, {
        layout,
        metricInfos: model.metricInfos,
        selectedRefId,
        displayMode,
        showValues: options.showValues,
        missingColor: options.missingColor,
        theme,
        scrollTop,
        viewportH: bodyH,
      });
    }
  }, [layout, model, selectedRefId, displayMode, options, theme, scrollTop, bodyH]);

  if (data.series.length === 0) {
    return <PanelDataErrorView panelId={props.id} data={data} />;
  }
  if (options.levels.length === 0) {
    return <p>パネルオプションで階層レベルを設定してください。</p>;
  }
  if (model.warnings.length > 0 && layout.cells.length === 0) {
    return (
      <div role="alert">
        {model.warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    );
  }

  return (
    <div style={{ width, height, overflow: 'hidden' }}>
      {showHeader && (
        <div style={{ height: HEADER_H }}>
          <RadioButtonGroup
            size="sm"
            // 選択肢はrefId基準。0系列クエリはmetricInfoが無いためrefIdを表示名にフォールバックする
            options={model.refIds.map((refId) => ({
              value: refId,
              label: model.metricInfos.find((m) => m.refId === refId)?.name ?? refId,
            }))}
            value={selectedRefId}
            onChange={setSelected}
          />
        </div>
      )}
      <div
        ref={scrollRef}
        style={{
          width,
          height: bodyH,
          position: 'relative',
          overflowY: layout.scrollable ? 'auto' : 'hidden',
          // S_MINでも幅に収まらない設定(列数過多など)では横スクロールで切れを防ぐ
          overflowX: layout.contentWidth > width ? 'auto' : 'hidden',
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          // hitTestもツールチップも、スクロールコンテナのコンテンツ座標系で扱う。
          // absolute子のツールチップはコンテンツ座標に置かれ、hitTestの当たり判定もコンテンツ座標のため、
          // 縦横スクロール量(scrollTop/scrollLeft)を加味しないとスクロール時に別セル判定・誤配置になる。
          const cx = e.clientX - rect.left + e.currentTarget.scrollLeft;
          const cy = e.clientY - rect.top + e.currentTarget.scrollTop;
          const hit = hitTest(layout, cx, cy);
          setHover(hit ? { cell: hit.cell, x: cx, y: cy } : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvasRef} />
        {hover && (
          <CellTooltip
            cell={hover.cell}
            metricInfos={model.metricInfos}
            missingColor={options.missingColor}
            x={hover.x}
            y={hover.y}
          />
        )}
      </div>
    </div>
  );
};
