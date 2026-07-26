import { DisplayValue, GrafanaTheme2 } from '@grafana/data';
import { CategoryModel, primaryCategoryValue } from '../data/categories';
import { MetricInfo, chooseCellText } from '../data/display';
import { LayoutResult } from '../layout/layout';
import { CategoryDecorationStyle, DisplayMode } from '../types';
import { cellRangeFor } from '../data/cellRange';
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
  category?: CategoryModel;
  categoryStyle: CategoryDecorationStyle;
}

function drawCategoryDecoration(
  ctx: CanvasRenderingContext2D,
  c: LayoutResult['cells'][number],
  color: string,
  style: CategoryDecorationStyle
): void {
  if (style === 'topBar') {
    ctx.fillStyle = color;
    ctx.fillRect(c.x, c.y, c.w, Math.max(1, Math.round(c.h * 0.2)));
  } else {
    const lw = c.w >= 14 ? 2 : 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(c.x + lw / 2, c.y + lw / 2, c.w - lw, c.h - lw);
  }
  ctx.lineWidth = 1;
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

  // Border
  ctx.strokeStyle = theme.colors.border.medium;
  for (const b of layout.borders) {
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  }

  // Cells
  const infoByRef = new Map(rc.metricInfos.map((m) => [m.refId, m]));
  // When the selected refId has no MetricInfo (e.g. a 0-series query), don't fall back — render it as missing
  const selected = infoByRef.get(rc.selectedRefId);
  // In split mode, zone rendering kicks in even with a single MetricInfo (with one, all zones = the whole cell). This way, even
  // when the selected refId has 0 series, it's drawn with MetricInfo's color regardless of selection, keeping it consistent with the legend (based on metricInfos) and click detection
  const split = rc.displayMode === 'split' && rc.metricInfos.length > 0;
  const rects = split ? splitRects(rc.metricInfos.length) : null;

  for (const c of layout.cells) {
    let display: DisplayValue | undefined;
    if (split && rects) {
      rc.metricInfos.slice(0, rects.length).forEach((info, i) => {
        const v = c.cell.values.get(info.refId) ?? null;
        const processor = cellRangeFor(c.cell, info).processor;
        ctx.fillStyle = v === null ? rc.missingColor : (processor(v).color ?? rc.missingColor);
        const r = rects[i];
        ctx.fillRect(c.x + r.x * c.w, c.y + r.y * c.h, r.w * c.w - 0.5, r.h * c.h - 0.5);
      });
    } else {
      if (!selected) {
        // No selected metric (e.g. a 0-series refId is selected) → render the whole cell with the missing color
        ctx.fillStyle = rc.missingColor;
        ctx.fillRect(c.x, c.y, c.w, c.h);
      } else {
        const v = c.cell.values.get(selected.refId) ?? null;
        if (v === null) {
          ctx.fillStyle = rc.missingColor;
          ctx.fillRect(c.x, c.y, c.w, c.h);
        } else {
          display = cellRangeFor(c.cell, selected).processor(v);
          ctx.fillStyle = display.color ?? rc.missingColor;
          ctx.fillRect(c.x, c.y, c.w, c.h);
        }
      }
    }

    const categoryValue = rc.category ? primaryCategoryValue(c.cell, rc.category.label) : undefined;
    const categoryColor = categoryValue ? rc.category?.colorByValue.get(categoryValue) : undefined;
    if (categoryColor) {
      drawCategoryDecoration(ctx, c, categoryColor, rc.categoryStyle);
      ctx.strokeStyle = theme.colors.border.medium;
    }

    if (!split && rc.showValues && display) {
      const fit = chooseCellText(display, c.w, c.h, (text, fontPx) => {
        ctx.font = `${fontPx}px ${theme.typography.fontFamily}`;
        return ctx.measureText(text).width;
      });
      if (fit) {
        ctx.font = `${fit.fontPx}px ${theme.typography.fontFamily}`;
        ctx.fillStyle = theme.colors.getContrastText(display.color ?? rc.missingColor);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fit.text, c.x + c.w / 2, c.y + c.h / 2);
      }
    }
  }

  // Group label
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `${12}px ${theme.typography.fontFamily}`;
  ctx.fillStyle = theme.colors.text.primary;
  for (const l of layout.labels) {
    ctx.fillText(l.text, l.x + 2, l.y + l.h / 2, l.w - 4);
  }

  // While scrolling: pin the top-level label's display to the top edge
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
