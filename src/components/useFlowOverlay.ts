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
import { renderFlowLayer } from '../render/flowRenderer';
import { CellModel, FleetGridOptions, HierarchyNode } from '../types';

const NO_FRAMES: DataFrame[] = [];

export interface FlowOverlayInput {
  /** null while the overlay is off: nothing is mounted and nothing is drawn. */
  model: FlowModel | null;
  /** The canvas of the arcs at rest and the canvas of the arcs in focus, both stacked on the cell canvas. */
  restRef: React.RefObject<HTMLCanvasElement>;
  focusRef: React.RefObject<HTMLCanvasElement>;
  layout: LayoutResult;
  viewportH: number;
  theme: GrafanaTheme2;
  /** The cell whose edges are emphasised (the hovered cell, or the cell of the open popover). */
  focusCell: CellModel | null;
}

export interface FlowOverlayState {
  /** The focused cell's edges for the tooltip, or null when it has none. */
  summary: FlowNodeSummary | null;
  /** Whether arcs are in focus, so that the resting layer is to be dimmed. */
  focused: boolean;
}

// Edge colors resolved so far, for one model and theme.
interface ColorCache {
  model: FlowModel | null;
  theme: GrafanaTheme2 | null;
  colors: Map<FlowEdge, string>;
}

const NO_EDGES: FlowEdge[] = [];

// A display processor formats text as well as picking the color, so each edge is resolved once and kept
// for the later paints of the same model (the focus layer is painted on every change of focus).
function edgeColors(cache: ColorCache, model: FlowModel, theme: GrafanaTheme2): (edge: FlowEdge) => string {
  const processor = model.metricInfo?.processor;
  return (edge) => {
    let color = cache.colors.get(edge);
    if (color === undefined) {
      const display = edge.value !== null && processor ? processor(edge.value) : undefined;
      color = display?.color ?? theme.colors.text.secondary;
      cache.colors.set(edge, color);
    }
    return color;
  };
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
 * Keeps the two overlay canvases painted. Each stage is memoized on what it reads: a pointer move inside
 * one cell (or between the cells of one group) paints nothing, a change of the focused node paints the
 * focus layer only (the resting layer is dimmed with CSS by the caller), and neither runs the layout or
 * the cell pipeline again.
 */
export function useFlowOverlay(input: FlowOverlayInput): FlowOverlayState {
  const { model, restRef, focusRef, layout, viewportH, theme, focusCell } = input;
  const depth = model?.depth ?? 0;
  const anchors = useMemo(() => (depth > 0 ? flowAnchors(layout, depth) : new Map()), [layout, depth]);
  const rest = useMemo(() => (model ? flowBaseEdges(model) : NO_EDGES), [model]);
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
    const canvas = restRef.current;
    if (!canvas || !model) {
      return;
    }
    if (colorCache.current.model !== model || colorCache.current.theme !== theme) {
      colorCache.current = { model, theme, colors: new Map() };
    }
    const colorOf = edgeColors(colorCache.current, model, theme);
    const edges = rest;
    renderFlowLayer(canvas, { layout, viewportH, anchors, edges, emphasised: false, retain: false, colorOf, theme });
  }, [restRef, model, layout, viewportH, anchors, rest, theme]);

  useEffect(() => {
    const canvas = focusRef.current;
    if (!canvas || !model) {
      return;
    }
    if (colorCache.current.model !== model || colorCache.current.theme !== theme) {
      colorCache.current = { model, theme, colors: new Map() };
    }
    const colorOf = edgeColors(colorCache.current, model, theme);
    const edges = focus ?? NO_EDGES;
    renderFlowLayer(canvas, { layout, viewportH, anchors, edges, emphasised: true, retain: true, colorOf, theme });
  }, [focusRef, model, layout, viewportH, anchors, focus, theme]);

  return { summary, focused: focus !== null };
}
