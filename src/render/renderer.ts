import { GrafanaTheme2 } from '@grafana/data';
import { MetricInfo, chooseCellText } from '../data/display';
import { LayoutResult } from '../layout/layout';
import { DisplayMode } from '../types';
import { splitRects } from './split';

export interface RenderContext {
  layout: LayoutResult;
  metricInfos: MetricInfo[];
  selectedRefId: string;
  displayMode: DisplayMode;
  showValues: boolean;
  missingColor: string;
  theme: GrafanaTheme2;
  scrollTop: number;
  viewportH: number;
}

export function renderCanvas(canvas: HTMLCanvasElement, rc: RenderContext): void {
  const { layout, theme } = rc;
  const dpr = window.devicePixelRatio || 1;
  const cssW = layout.contentWidth;
  const cssH = Math.max(layout.contentHeight, rc.viewportH);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // 枠線
  ctx.strokeStyle = theme.colors.border.medium;
  for (const b of layout.borders) {
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  }

  // セル
  const infoByRef = new Map(rc.metricInfos.map((m) => [m.refId, m]));
  const selected = infoByRef.get(rc.selectedRefId) ?? rc.metricInfos[0];
  const split = rc.displayMode === 'split' && rc.metricInfos.length > 1;
  const rects = split ? splitRects(rc.metricInfos.length) : null;

  for (const c of layout.cells) {
    if (split && rects) {
      rc.metricInfos.slice(0, rects.length).forEach((info, i) => {
        const v = c.cell.values.get(info.refId) ?? null;
        ctx.fillStyle = v === null ? rc.missingColor : (info.processor(v).color ?? rc.missingColor);
        const r = rects[i];
        ctx.fillRect(c.x + r.x * c.w, c.y + r.y * c.h, r.w * c.w - 0.5, r.h * c.h - 0.5);
      });
      continue;
    }
    if (!selected) {
      continue;
    }
    const v = c.cell.values.get(selected.refId) ?? null;
    if (v === null) {
      ctx.fillStyle = rc.missingColor;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      continue;
    }
    const disp = selected.processor(v);
    ctx.fillStyle = disp.color ?? rc.missingColor;
    ctx.fillRect(c.x, c.y, c.w, c.h);

    if (rc.showValues) {
      const fit = chooseCellText(disp, c.w, c.h, (text, fontPx) => {
        ctx.font = `${fontPx}px ${theme.typography.fontFamily}`;
        return ctx.measureText(text).width;
      });
      if (fit) {
        ctx.font = `${fit.fontPx}px ${theme.typography.fontFamily}`;
        ctx.fillStyle = theme.colors.getContrastText(disp.color ?? rc.missingColor);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fit.text, c.x + c.w / 2, c.y + c.h / 2);
      }
    }
  }

  // グループラベル
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `${12}px ${theme.typography.fontFamily}`;
  ctx.fillStyle = theme.colors.text.primary;
  for (const l of layout.labels) {
    ctx.fillText(l.text, l.x + 2, l.y + l.h / 2, l.w - 4);
  }

  // スクロール時: 最上位レベルのラベルを上端に固定表示
  if (rc.scrollTop > 0) {
    const tops = layout.labels.filter((l) => l.depth === 1);
    const current = [...tops].reverse().find((l) => l.y <= rc.scrollTop);
    if (current) {
      ctx.fillStyle = theme.colors.background.primary;
      ctx.fillRect(current.x, rc.scrollTop, current.w, current.h);
      ctx.fillStyle = theme.colors.text.primary;
      ctx.fillText(current.text, current.x + 2, rc.scrollTop + current.h / 2, current.w - 4);
    }
  }
}
