import { CellModel, HierarchyNode, LevelDef } from '../types';

export const S_MIN = 6;
export const S_MAX = 40;
export const CELL_GAP = 1;
export const GROUP_GAP = 4;
export const LABEL_H = 16;
export const BORDER_PAD = 2;

export interface LayoutCell {
  x: number;
  y: number;
  w: number;
  h: number;
  cell: CellModel;
}

export interface LayoutLabel {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface LayoutBorder {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface LayoutResult {
  cells: LayoutCell[];
  labels: LayoutLabel[];
  borders: LayoutBorder[];
  cellSize: number;
  contentWidth: number;
  contentHeight: number;
  scrollable: boolean;
}

interface Out {
  cells: LayoutCell[];
  labels: LayoutLabel[];
  borders: LayoutBorder[];
}

interface Size {
  w: number;
  h: number;
}

export function computeLayout(
  root: HierarchyNode,
  levels: LevelDef[],
  width: number,
  height: number
): LayoutResult {
  const measure = (s: number): Size => layoutNode(root, levels, s, width, 0, 0, null);
  const fits = (s: number) => {
    const m = measure(s);
    return m.w <= width && m.h <= height;
  };

  // flowレイアウトの折返し位置が変わる境界で fits(s) の単調性が崩れるため、
  // 二分探索ではなく上限から0.5px刻みの降順走査で「収まる最大のs」を決める(最大69候補、走査はミリ秒オーダー)
  let s = S_MIN;
  for (let cand = S_MAX; cand >= S_MIN; cand -= 0.5) {
    if (fits(cand)) {
      s = cand;
      break;
    }
  }

  const out: Out = { cells: [], labels: [], borders: [] };
  const size = layoutNode(root, levels, s, width, 0, 0, out);
  return {
    ...out,
    cellSize: s,
    contentWidth: size.w,
    contentHeight: size.h,
    scrollable: size.h > height,
  };
}

function layoutNode(
  node: HierarchyNode,
  levels: LevelDef[],
  s: number,
  availW: number,
  x: number,
  y: number,
  out: Out | null
): Size {
  const depth = node.path.length;
  if (depth === levels.length) {
    if (out && node.cell) {
      out.cells.push({ x, y, w: s, h: s, cell: node.cell });
    }
    return { w: s, h: s };
  }

  const childDef = levels[depth];
  const childIsLeaf = depth === levels.length - 1;
  const gap = childIsLeaf ? CELL_GAP : GROUP_GAP;
  const pad = childDef.showBorder ? BORDER_PAD : 0;
  const labelH = childDef.showLabel && !childIsLeaf ? LABEL_H : 0;

  // 子(装飾込み)の配置。emit=nullなら計測のみ
  const childBox = (child: HierarchyNode, innerAvailW: number, cx: number, cy: number, emit: Out | null): Size => {
    const inner = layoutNode(child, levels, s, innerAvailW - pad * 2, cx + pad, cy + pad + labelH, emit);
    const w = inner.w + pad * 2;
    const h = inner.h + pad * 2 + labelH;
    if (emit) {
      if (labelH) {
        emit.labels.push({ text: child.key, x: cx + pad, y: cy + pad, w: inner.w, h: LABEL_H, depth: depth + 1 });
      }
      if (childDef.showBorder) {
        emit.borders.push({ x: cx, y: cy, w, h, depth: depth + 1 });
      }
    }
    return { w, h };
  };

  switch (childDef.layout) {
    case 'vertical': {
      let w = 0;
      let h = 0;
      for (const c of node.children) {
        const size = childBox(c, availW, x, y + h, out);
        w = Math.max(w, size.w);
        h += size.h + gap;
      }
      return { w, h: Math.max(0, h - gap) };
    }
    case 'horizontal': {
      let w = 0;
      let h = 0;
      for (const c of node.children) {
        const size = childBox(c, Math.max(0, availW - w), x + w, y, out);
        h = Math.max(h, size.h);
        w += size.w + gap;
      }
      return { w: Math.max(0, w - gap), h };
    }
    case 'flow': {
      let cx = 0;
      let cy = 0;
      let rowH = 0;
      let maxW = 0;
      for (const c of node.children) {
        const m = childBox(c, availW, 0, 0, null);
        if (cx > 0 && cx + m.w > availW) {
          cx = 0;
          cy += rowH + gap;
          rowH = 0;
        }
        childBox(c, availW, x + cx, y + cy, out);
        cx += m.w + gap;
        rowH = Math.max(rowH, m.h);
        maxW = Math.max(maxW, cx - gap);
      }
      return { w: maxW, h: cy + rowH };
    }
    case 'grid': {
      const cols = Math.max(1, childDef.gridColumns ?? 1);
      let cellW = 0;
      let cellH = 0;
      for (const c of node.children) {
        const m = childBox(c, availW, 0, 0, null);
        cellW = Math.max(cellW, m.w);
        cellH = Math.max(cellH, m.h);
      }
      node.children.forEach((c, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        childBox(c, availW, x + col * (cellW + gap), y + row * (cellH + gap), out);
      });
      const rows = Math.ceil(node.children.length / cols);
      return {
        w: node.children.length > 0 ? Math.min(cols, node.children.length) * (cellW + gap) - gap : 0,
        h: rows > 0 ? rows * (cellH + gap) - gap : 0,
      };
    }
  }
}
