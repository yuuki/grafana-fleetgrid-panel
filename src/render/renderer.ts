import { DisplayValue, GrafanaTheme2 } from '@grafana/data';
import { CategoryModel, primaryCategoryValue } from '../data/categories';
import { MetricInfo, chooseCellText } from '../data/display';
import { LayoutCell, LayoutLabel, LayoutResult } from '../layout/layout';
import { CategoryDecorationStyle, CellModel, DisplayMode } from '../types';
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
  /** Category values that lock the highlight via legend clicks. */
  selectedCategoryValues?: string[];
  /** A single category value transiently highlighted while its legend chip is hovered. Overrides the click selection. */
  hoverCategoryValue?: string;
}

// Cell geometry resolved to the device-pixel grid. The canvas is scaled by devicePixelRatio, so a coordinate
// is crisp only when coordinate*dpr is an integer. computeLayout sizes cells in 0.5px steps, so raw cell
// edges rarely land there. We snap each edge to device space (round(v*dpr)/dpr) — never to CSS integers,
// which would move an already-aligned edge (e.g. 2.5 at dpr=2) and expose a sliver of fill. The metric fill
// shares this same snapped rect, so fill and decoration always meet on the exact same device boundary.
interface CellGeom {
  // Device-aligned outer rect, in CSS px (the units the scaled context draws in).
  x: number;
  y: number;
  w: number;
  h: number;
  // Outer rect measured in whole device pixels, used for all band-thickness and cap arithmetic.
  dw: number;
  dh: number;
  dpr: number;
  // Split tiling the cell is divided into (1x1 when not split), so caps keep the outermost tiles visible.
  cols: number;
  rows: number;
  // Grout (device px) removed from each split tile's right/bottom edge; 0 when not split.
  groutDev: number;
  // Cumulative device-px column/row edges from the cell origin (length cols+1 / rows+1), integer so every
  // interior split boundary lands exactly on the device grid.
  colEdges: number[];
  rowEdges: number[];
  // Smallest tile's *visible fill* extent (device px) after grout — the real budget a decoration band has.
  minColFillDev: number;
  minRowFillDev: number;
  // Original (pre-snap) logical size, used for spec-defined band widths like the strip height so they don't
  // jitter with sub-pixel snapping of position.
  logicalW: number;
  logicalH: number;
}

function cellGeom(c: LayoutResult['cells'][number], dpr: number, cols: number, rows: number, split: boolean): CellGeom {
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const x = snap(c.x);
  const y = snap(c.y);
  const w = snap(c.x + c.w) - x;
  const h = snap(c.y + c.h) - y;
  const dw = Math.round(w * dpr);
  const dh = Math.round(h * dpr);
  const colEdges = Array.from({ length: cols + 1 }, (_, k) => Math.round((k / cols) * dw));
  const rowEdges = Array.from({ length: rows + 1 }, (_, k) => Math.round((k / rows) * dh));
  // Smallest raw tile edge (device px), before grout, across the split grid.
  let minRawColW = Infinity;
  let minRawRowH = Infinity;
  for (let k = 0; k < cols; k++) {
    minRawColW = Math.min(minRawColW, colEdges[k + 1] - colEdges[k]);
  }
  for (let k = 0; k < rows; k++) {
    minRawRowH = Math.min(minRawRowH, rowEdges[k + 1] - rowEdges[k]);
  }
  // Integer device-px grout keeps the split separators crisp at any DPR (a fixed 0.5 CSS px would be a
  // fractional device width, e.g. 0.75px at dpr=1.5, and blur). It shrinks — down to 0 — so the smallest raw
  // tile always keeps at least 1 device px of fill; otherwise, at DPR<1, a 1px grout would erase narrow tiles.
  const groutDev = split
    ? Math.max(0, Math.min(Math.max(1, Math.round(0.5 * dpr)), minRawColW - 1, minRawRowH - 1))
    : 0;
  const minColFillDev = minRawColW - groutDev;
  const minRowFillDev = minRawRowH - groutDev;
  return {
    x,
    y,
    w,
    h,
    dw,
    dh,
    dpr,
    cols,
    rows,
    groutDev,
    colEdges,
    rowEdges,
    minColFillDev,
    minRowFillDev,
    logicalW: c.w,
    logicalH: c.h,
  };
}

// Widest all-four-side band (device px) a cell can carry while keeping every split tile's *visible fill*
// (post-grout) at least 1 device px. An outer column/row is eaten from one side by its edge band; a sole
// column/row (single mode, or a 1-wide split axis) is eaten from both sides, so it halves.
function bandCapDev(g: CellGeom): number {
  const h = g.cols === 1 ? Math.floor((g.minColFillDev - 1) / 2) : g.minColFillDev - 1;
  const v = g.rows === 1 ? Math.floor((g.minRowFillDev - 1) / 2) : g.minRowFillDev - 1;
  return Math.max(0, Math.min(h, v));
}

// Band widths are specified in logical px (frame 1–2, moat 2, ring 2, separator 1), quantized to whole
// device pixels and clamped to the cap so tiny cells never lose their fill or their outer split tiles.
function outlineBandsDev(g: CellGeom): { frame: number; moat: number } {
  const cap = bandCapDev(g);
  const frame = Math.min(Math.round((g.logicalW >= 14 ? 2 : 1) * g.dpr), cap);
  return { frame, moat: Math.min(Math.round(2 * g.dpr), cap - frame) };
}

function ringBandsDev(g: CellGeom): { ring: number; sep: number } {
  const cap = bandCapDev(g);
  const ring = Math.min(Math.round(2 * g.dpr), cap);
  return { ring, sep: Math.min(Math.round(g.dpr), cap - ring) };
}

// The bottom strip only eats from the cell's lower edge, so its cap is the shortest row's visible fill.
function stripHeightDev(g: CellGeom): number {
  const logical = Math.max(2, Math.round(g.logicalH * 0.15)); // ~15% of the *logical* height, floored at 2px
  const cap = Math.max(0, g.minRowFillDev - 1);
  return Math.min(Math.round(logical * g.dpr), cap);
}

// Draw a rectangular band `tDev` device-px thick, inset `insetDev` device-px from the outer edge, as four
// fillRect bars. All inputs are whole device pixels, so every emitted edge is device-aligned and crisp.
function fillBand(ctx: CanvasRenderingContext2D, g: CellGeom, insetDev: number, tDev: number): void {
  if (tDev <= 0) {
    return;
  }
  const inset = insetDev / g.dpr;
  const t = tDev / g.dpr;
  const x = g.x + inset;
  const y = g.y + inset;
  const w = g.w - 2 * inset;
  const h = g.h - 2 * inset;
  ctx.fillRect(x, y, w, t); // top
  ctx.fillRect(x, y + h - t, w, t); // bottom
  ctx.fillRect(x, y + t, t, h - 2 * t); // left
  ctx.fillRect(x + w - t, y + t, t, h - 2 * t); // right
}

function drawCategoryDecoration(
  ctx: CanvasRenderingContext2D,
  g: CellGeom,
  color: string,
  style: CategoryDecorationStyle,
  bgColor: string
): void {
  if (style === 'strip') {
    // Bottom strip (not top): a full-width band on the cell's lower edge. It stays clear of the centered
    // value text and reads as a base for the cell, rather than being squeezed between the value and the
    // group label above the cell.
    const shDev = stripHeightDev(g);
    if (shDev > 0) {
      const sh = shDev / g.dpr;
      ctx.fillStyle = color;
      ctx.fillRect(g.x, g.y + g.h - sh, g.w, sh);
    }
    return;
  }
  // Outline: a category-color frame on the outer edge with a background moat just inside it, so the frame
  // never touches the metric fill (adjacent color+fill would blend and muddy the category hue).
  const { frame, moat } = outlineBandsDev(g);
  ctx.fillStyle = color;
  fillBand(ctx, g, 0, frame);
  if (moat > 0) {
    // Draw the moat opaque even while the cell is dimmed, so the frame stays visually detached from the
    // fill instead of the whole band fading into a muddy blend.
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = 1;
    ctx.fillStyle = bgColor;
    fillBand(ctx, g, frame, moat);
    ctx.globalAlpha = prevAlpha;
  }
}

// Highlight ring: a colored ring hugging the cell's outer edge with an inner background separator. Drawn
// on matching cells during highlight (click selection and hover) regardless of the decoration style, so the
// match is double-encoded (ring + un-dimmed) rather than relying on brightness alone.
function drawCategoryRing(ctx: CanvasRenderingContext2D, g: CellGeom, color: string, bgColor: string): void {
  const { ring, sep } = ringBandsDev(g);
  if (ring <= 0) {
    return;
  }
  ctx.fillStyle = color;
  fillBand(ctx, g, 0, ring);
  if (sep > 0) {
    ctx.fillStyle = bgColor;
    fillBand(ctx, g, ring, sep);
  }
}

// Safe inset (CSS px) the value text must avoid on each side so it never collides with the decoration or
// ring. Taken as the max (not sum) across features because bands are concentric from the outer edge.
function textInsets(
  g: CellGeom,
  style: CategoryDecorationStyle,
  hasCategory: boolean,
  ringed: boolean
): { x: number; top: number; bottom: number } {
  let x = 0;
  let top = 0;
  let bottom = 0;
  if (hasCategory) {
    if (style === 'strip') {
      bottom = Math.max(bottom, stripHeightDev(g) / g.dpr);
    } else {
      const { frame, moat } = outlineBandsDev(g);
      const d = (frame + moat) / g.dpr;
      x = Math.max(x, d);
      top = Math.max(top, d);
      bottom = Math.max(bottom, d);
    }
  }
  if (ringed) {
    const { ring, sep } = ringBandsDev(g);
    const d = (ring + sep) / g.dpr;
    x = Math.max(x, d);
    top = Math.max(top, d);
    bottom = Math.max(bottom, d);
  }
  return { x, top, bottom };
}

// Size the canvas backing store for the device pixel ratio and return a cleared, dpr-scaled 2D context.
function prepareCanvas(
  canvas: HTMLCanvasElement,
  layout: LayoutResult,
  viewportH: number,
  dpr: number
): CanvasRenderingContext2D | null {
  const cssW = layout.contentWidth;
  const cssH = Math.max(layout.contentHeight, viewportH);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return ctx;
}

function drawBorders(ctx: CanvasRenderingContext2D, borders: LayoutResult['borders'], theme: GrafanaTheme2): void {
  ctx.strokeStyle = theme.colors.border.medium;
  for (const b of borders) {
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  }
}

// Per-render values shared by every cell, resolved once before the cell loop.
interface CellPass {
  rc: RenderContext;
  dpr: number;
  split: boolean;
  // Number of split tiles actually laid out (0 when not split).
  tileCount: number;
  cols: number;
  rows: number;
  selected: MetricInfo | undefined;
  activeHighlight: string[];
  // A category is active and at least one value is highlighted, so non-matching cells are dimmed.
  highlighting: boolean;
  bgColor: string;
}

function cellPass(rc: RenderContext, dpr: number): CellPass {
  const infoByRef = new Map(rc.metricInfos.map((m) => [m.refId, m]));
  // When the selected refId has no MetricInfo (e.g. a 0-series query), don't fall back — render it as missing
  const selected = infoByRef.get(rc.selectedRefId);
  // In split mode, zone rendering kicks in even with a single MetricInfo (with one, all zones = the whole cell). This way, even
  // when the selected refId has 0 series, it's drawn with MetricInfo's color regardless of selection, keeping it consistent with the legend (based on metricInfos) and click detection
  const split = rc.displayMode === 'split' && rc.metricInfos.length > 0;
  const rects = split ? splitRects(rc.metricInfos.length) : null;
  // Split tiling (cols/rows) drives the decoration caps so the outermost tiles keep a visible sliver of fill.
  // splitRects lays tiles out on a cols×rows grid, so 1/tileWidth = cols and 1/tileHeight = rows.
  const cols = rects ? Math.round(1 / rects[0].w) : 1;
  const rows = rects ? Math.round(1 / rects[0].h) : 1;

  // Hovering a legend chip transiently narrows the highlight to that single value, overriding the
  // click selection; with no hover, the locked click selection drives the highlight.
  const activeHighlight = rc.hoverCategoryValue ? [rc.hoverCategoryValue] : (rc.selectedCategoryValues ?? []);
  return {
    rc,
    dpr,
    split,
    tileCount: rects ? rects.length : 0,
    cols,
    rows,
    selected,
    activeHighlight,
    highlighting: !!rc.category && activeHighlight.length > 0,
    bgColor: rc.theme.colors.background.primary,
  };
}

// The value that actually triggers the highlight (the hovered value while hovering, otherwise the
// first selected value the cell carries). Its color — not the primary value's — drives the ring, so a
// multi-value cell highlighted via a secondary value rings in that value's color.
function matchedHighlightValue(
  cell: CellModel,
  category: CategoryModel | undefined,
  activeHighlight: string[]
): string | undefined {
  if (!category || activeHighlight.length === 0) {
    return undefined;
  }
  const cellValues = cell.labelValues?.get(category.label) ?? [];
  return cellValues.find((value) => activeHighlight.includes(value));
}

function categoryColorFor(category: CategoryModel | undefined, value: string | undefined): string | undefined {
  return value ? category?.colorByValue.get(value) : undefined;
}

function fillSplitTiles(ctx: CanvasRenderingContext2D, cell: CellModel, g: CellGeom, p: CellPass): void {
  const { metricInfos, missingColor } = p.rc;
  const n = Math.min(metricInfos.length, p.tileCount);
  for (let i = 0; i < n; i++) {
    const info = metricInfos[i];
    const v = cell.values.get(info.refId) ?? null;
    const processor = cellRangeFor(cell, info).processor;
    ctx.fillStyle = v === null ? missingColor : (processor(v).color ?? missingColor);
    // Tiles use the integer device-px column/row edges (matching splitRects' i%cols / floor(i/cols)),
    // with an integer device-px grout on the right/bottom, so every tile boundary is device-aligned.
    const col = i % g.cols;
    const row = Math.floor(i / g.cols);
    const x0 = g.colEdges[col];
    const y0 = g.rowEdges[row];
    const fw = g.colEdges[col + 1] - x0 - g.groutDev;
    const fh = g.rowEdges[row + 1] - y0 - g.groutDev;
    if (fw > 0 && fh > 0) {
      ctx.fillRect(g.x + x0 / g.dpr, g.y + y0 / g.dpr, fw / g.dpr, fh / g.dpr);
    }
  }
}

// Display value of the selected metric for a single-mode cell, or undefined when the cell renders as
// missing: no selected metric (e.g. a 0-series refId is selected) or no value for it in this cell.
function selectedDisplay(cell: CellModel, selected: MetricInfo | undefined): DisplayValue | undefined {
  if (!selected) {
    return undefined;
  }
  const v = cell.values.get(selected.refId) ?? null;
  if (v === null) {
    return undefined;
  }
  return cellRangeFor(cell, selected).processor(v);
}

// Draw the value text centered in the cell, shrunk by the decoration/ring safe insets.
function drawValueText(
  ctx: CanvasRenderingContext2D,
  g: CellGeom,
  display: DisplayValue,
  insets: { x: number; top: number; bottom: number },
  theme: GrafanaTheme2,
  missingColor: string
): void {
  const boxW = g.w - 2 * insets.x;
  const boxH = g.h - insets.top - insets.bottom;
  if (boxW <= 0 || boxH <= 0) {
    return;
  }
  const fit = chooseCellText(display, boxW, boxH, (text, fontPx) => {
    ctx.font = `${fontPx}px ${theme.typography.fontFamily}`;
    return ctx.measureText(text).width;
  });
  if (!fit) {
    return;
  }
  ctx.font = `${fit.fontPx}px ${theme.typography.fontFamily}`;
  ctx.fillStyle = theme.colors.getContrastText(display.color ?? missingColor);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Center within the inset-reduced box (strip pushes the center up; symmetric insets keep it centered).
  ctx.fillText(fit.text, g.x + insets.x + boxW / 2, g.y + insets.top + boxH / 2);
}

function drawCell(ctx: CanvasRenderingContext2D, c: LayoutCell, p: CellPass): void {
  const { rc, bgColor } = p;
  const matchedValue = matchedHighlightValue(c.cell, rc.category, p.activeHighlight);
  const matched = matchedValue !== undefined;
  const dimmed = p.highlighting && !matched;
  ctx.globalAlpha = dimmed ? 0.22 : 1;
  // Device-aligned geometry shared by the metric fill and the decoration, so both meet on the same edge.
  const g = cellGeom(c, p.dpr, p.cols, p.rows, p.split);
  let display: DisplayValue | undefined;
  if (p.split) {
    fillSplitTiles(ctx, c.cell, g, p);
  } else {
    display = selectedDisplay(c.cell, p.selected);
    ctx.fillStyle = display?.color ?? rc.missingColor;
    ctx.fillRect(g.x, g.y, g.w, g.h);
  }

  const categoryValue = rc.category ? primaryCategoryValue(c.cell, rc.category.label) : undefined;
  const categoryColor = categoryColorFor(rc.category, categoryValue);
  const ringColor = categoryColorFor(rc.category, matchedValue);
  if (categoryColor) {
    // Decoration is drawn under the current alpha, so a dimmed (non-matching) cell's decoration dims too.
    drawCategoryDecoration(ctx, g, categoryColor, rc.categoryStyle, bgColor);
  }

  if (!p.split && rc.showValues && display) {
    // Shrink the fit region by the decoration/ring safe insets so the value never sits under a band.
    const insets = textInsets(g, rc.categoryStyle, !!categoryColor, matched && !!ringColor);
    drawValueText(ctx, g, display, insets, rc.theme, rc.missingColor);
  }
  ctx.globalAlpha = 1;

  // Draw the highlight ring last, at full alpha, so it sits above the fill/decoration/text of the matched cell.
  if (matched && ringColor) {
    drawCategoryRing(ctx, g, ringColor, bgColor);
  }
}

function drawGroupLabels(ctx: CanvasRenderingContext2D, labels: LayoutLabel[], theme: GrafanaTheme2): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `${12}px ${theme.typography.fontFamily}`;
  ctx.fillStyle = theme.colors.text.primary;
  for (const l of labels) {
    ctx.fillText(l.text, l.x + 2, l.y + l.h / 2, l.w - 4);
  }
}

// Repaint the top-level label the viewport is scrolled into, pinned to the top edge (no-op when not scrolled).
function drawPinnedTopLabel(
  ctx: CanvasRenderingContext2D,
  labels: LayoutLabel[],
  scrollTop: number,
  theme: GrafanaTheme2
): void {
  if (scrollTop <= 0) {
    return;
  }
  const tops = labels.filter((l) => l.depth === 1);
  const current = [...tops].reverse().find((l) => l.y <= scrollTop);
  if (!current) {
    return;
  }
  ctx.fillStyle = theme.colors.background.primary;
  ctx.fillRect(current.x, scrollTop, current.w, current.h);
  ctx.fillStyle = theme.colors.text.primary;
  ctx.fillText(current.text, current.x + 2, scrollTop + current.h / 2, current.w - 4);
}

export function renderCanvas(canvas: HTMLCanvasElement, rc: RenderContext): void {
  const { layout, theme } = rc;
  const dpr = window.devicePixelRatio || 1;
  const ctx = prepareCanvas(canvas, layout, rc.viewportH, dpr);
  if (!ctx) {
    return;
  }

  // Border
  drawBorders(ctx, layout.borders, theme);

  // Cells
  const pass = cellPass(rc, dpr);
  for (const c of layout.cells) {
    drawCell(ctx, c, pass);
  }

  // Group label
  drawGroupLabels(ctx, layout.labels, theme);

  // While scrolling: pin the top-level label's display to the top edge
  drawPinnedTopLabel(ctx, layout.labels, rc.scrollTop, theme);
}
