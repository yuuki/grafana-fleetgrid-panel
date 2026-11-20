import React, { useEffect, useMemo, useRef } from 'react';
import { DataFrame, GrafanaTheme2 } from '@grafana/data';
import {
  FlowEdge,
  FlowModel,
  FlowNodeSummary,
  buildFlowModel,
  flowBaseEdges,
  flowFocusEdges,
  flowNodeKey,
  frameHasRefId,
  resolveFlowConfig,
  summarizeFlowNode,
} from '../data/edges';
import { LayoutResult } from '../layout/layout';
import { flowAnchors } from '../render/flowGeometry';
import { renderFlowOverlay } from '../render/flowRenderer';
import { CellModel, FleetGridOptions, HierarchyNode } from '../types';

const NO_FRAMES: DataFrame[] = [];

export interface FlowOverlayInput {
  /** null while the overlay is off: nothing is mounted and nothing is drawn. */
  model: FlowModel | null;
  /** The overlay's canvas, stacked on the cell canvas. */
  canvasRef: React.RefObject<HTMLCanvasElement>;
  layout: LayoutResult;
  viewportH: number;
  theme: GrafanaTheme2;
  /** The cell whose edges are emphasised (the hovered cell, or the cell of the open popover). */
  focusCell: CellModel | null;
}

// Edge colors resolved so far, for one model and theme.
interface ColorCache {
  model: FlowModel | null;
  theme: GrafanaTheme2 | null;
  colors: Map<FlowEdge, string>;
}

/**
 * The flow model of the panel, or null when no edge query is named. `series` holds all frames of the
 * panel (the edge query's frames are picked by refId) and `root` the hierarchy built from the other
 * queries. It does not depend on the layout, so its warnings are known before the layout is computed.
 */
export function useFlowModel(
  series: DataFrame[],
  options: FleetGridOptions,
  root: HierarchyNode,
  theme: GrafanaTheme2,
  timeZone: string
): FlowModel | null {
  const config = useMemo(() => resolveFlowConfig(options), [options]);
  const refId = config?.refId;
  const frames = useMemo(
    () => (refId === undefined ? NO_FRAMES : series.filter((frame) => frameHasRefId(frame, refId))),
    [series, refId]
  );
  return useMemo(
    () => (config ? buildFlowModel(frames, root, options, config, theme, timeZone) : null),
    [config, frames, root, options, theme, timeZone]
  );
}

/**
 * Keeps the overlay canvas painted and returns the focused cell's edge summary for the tooltip (null
 * when it has no edges). Each stage is memoized on what it reads, so a pointer move inside one cell (or
 * between the cells of one group) repaints nothing, a change of the focused node repaints the arcs only,
 * and neither runs the layout or the cell pipeline again.
 */
export function useFlowOverlay(input: FlowOverlayInput): FlowNodeSummary | null {
  const { model, canvasRef, layout, viewportH, theme, focusCell } = input;
  const depth = model?.depth ?? 0;
  const anchors = useMemo(() => (depth > 0 ? flowAnchors(layout, depth) : new Map()), [layout, depth]);
  const base = useMemo(() => (model ? flowBaseEdges(model) : []), [model]);
  // The focus is keyed by the node, not by the cell: the cells of one group share their group's edges.
  const focusKey = model && focusCell ? flowNodeKey(model, focusCell) : null;
  const focus = useMemo(
    () => (model && focusKey !== null ? flowFocusEdges(model, [focusKey]) : null),
    [model, focusKey]
  );
  const summary = useMemo(
    () => (model && focusKey !== null ? summarizeFlowNode(model, focusKey) : null),
    [model, focusKey]
  );
  const colorCache = useRef<ColorCache>({ model: null, theme: null, colors: new Map() });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model) {
      return;
    }
    // A display processor formats text as well as picking the color, so each edge is resolved once and
    // kept for the later repaints of the same model (a repaint per change of focus).
    if (colorCache.current.model !== model || colorCache.current.theme !== theme) {
      colorCache.current = { model, theme, colors: new Map() };
    }
    const colors = colorCache.current.colors;
    const processor = model.metricInfo?.processor;
    const colorOf = (edge: FlowEdge): string => {
      let color = colors.get(edge);
      if (color === undefined) {
        const display = edge.value !== null && processor ? processor(edge.value) : undefined;
        color = display?.color ?? theme.colors.text.secondary;
        colors.set(edge, color);
      }
      return color;
    };
    renderFlowOverlay(canvas, { layout, viewportH, anchors, base, focus, colorOf, theme });
  }, [canvasRef, model, layout, viewportH, anchors, base, focus, theme]);

  return summary;
}
