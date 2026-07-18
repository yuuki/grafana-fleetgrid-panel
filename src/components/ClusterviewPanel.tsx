import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanelProps } from '@grafana/data';
import { PanelDataErrorView } from '@grafana/runtime';
import { RadioButtonGroup, useTheme2 } from '@grafana/ui';
import { ClusterviewOptions } from '../types';
import { buildModel } from '../data/model';
import { computeLayout } from '../layout/layout';
import { renderCanvas } from '../render/renderer';

const HEADER_H = 32;

export const ClusterviewPanel: React.FC<PanelProps<ClusterviewOptions>> = (props) => {
  const { data, width, height, options, timeZone } = props;
  const theme = useTheme2();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [selected, setSelected] = useState<string | undefined>(options.defaultMetric || undefined);

  const targetRefIds = useMemo(
    () => (data.request?.targets ?? []).map((t) => t.refId).filter((r): r is string => Boolean(r)),
    [data.request]
  );
  const model = useMemo(
    () => buildModel(data.series, options, theme, timeZone, targetRefIds),
    [data.series, options, theme, timeZone, targetRefIds]
  );

  const showHeader = model.refIds.length > 1 && options.displayMode === 'single';
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
        displayMode: options.displayMode,
        showValues: options.showValues,
        missingColor: options.missingColor,
        theme,
        scrollTop,
        viewportH: bodyH,
      });
    }
  }, [layout, model, selectedRefId, options, theme, scrollTop, bodyH]);

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
            options={model.metricInfos.map((m) => ({ value: m.refId, label: m.name }))}
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
      >
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
};
