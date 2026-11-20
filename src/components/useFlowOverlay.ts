import React, { useEffect, useMemo, useRef } from 'react';
import { DataFrame, DataQueryRequest, GrafanaTheme2, PanelData } from '@grafana/data';
import {
  FlowEdge,
  FlowModel,
  FlowNodeSummary,
  buildFlowModel,
  flowBaseEdges,
  flowFocusEdges,
  flowNodeKey,
  flowRefId,
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
  /**
   * The cells whose edges can be emphasised, most important first: the hovered cell, then the cell of
   * the open popover. The first one that is set is in focus.
   */
  focusCandidates: Array<{ cell: CellModel } | null>;
}

export interface FlowOverlayState {
  /** Whether an edge query is named, so that the overlay canvases are to be mounted. */
  active: boolean;
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
// for the later paints of the same model (the focus layer is painted on every change of focus). Called
// from the paint effects only: it replaces the cache when the model or the theme changed.
function edgeColors(
  cacheRef: React.MutableRefObject<ColorCache>,
  model: FlowModel,
  theme: GrafanaTheme2
): (edge: FlowEdge) => string {
  if (cacheRef.current.model !== model || cacheRef.current.theme !== theme) {
    cacheRef.current = { model, theme, colors: new Map() };
  }
  const colors = cacheRef.current.colors;
  const processor = model.metricInfo?.processor;
  return (edge) => {
    let color = colors.get(edge);
    if (color === undefined) {
      const display = edge.value !== null && processor ? processor(edge.value) : undefined;
      color = display?.color ?? theme.colors.text.secondary;
      colors.set(edge, color);
    }
    return color;
  };
}

export interface CellQueries {
  /** The frames the cells are built from: all frames but the edge query's. */
  series: DataFrame[];
  /** refIds of the cell queries, in the order of the panel's targets. */
  targetRefIds: string[];
  /** The panel's request without the edge query's target, for the drilldown requery. */
  request: DataQueryRequest | undefined;
}

/**
 * The panel's queries without the flow overlay's edge query. The edge query is not a cell metric: its
 * frames and its target stay out of the cell pipeline, the metric selector and the drilldown requery
 * (which would re-run a possibly very large pairwise query as a range query). While no edge query is
 * named, the frames and the request are returned as they are.
 */
export function useCellQueries(data: PanelData, options: FleetGridOptions): CellQueries {
  const edgeRefId = flowRefId(options);
  const series = useMemo(
    () => (edgeRefId === '' ? data.series : data.series.filter((frame) => !frameHasRefId(frame, edgeRefId))),
    [data.series, edgeRefId]
  );
  const request = useMemo(() => {
    if (edgeRefId === '' || !data.request) {
      return data.request;
    }
    return { ...data.request, targets: (data.request.targets ?? []).filter((t) => t.refId !== edgeRefId) };
  }, [data.request, edgeRefId]);
  const targetRefIds = useMemo(
    () => (request?.targets ?? []).map((t) => t.refId).filter((r): r is string => Boolean(r)),
    [request]
  );
  return { series, targetRefIds, request };
}

/** The cell warnings followed by the flow overlay's; the cell warnings themselves while there are none to add. */
export function withFlowWarnings(warnings: string[], model: FlowModel | null): string[] {
  return model && model.warnings.length > 0 ? [...warnings, ...model.warnings] : warnings;
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
  const { model, restRef, focusRef, layout, viewportH, theme, focusCandidates } = input;
  const focusCell = focusCandidates.find((candidate) => candidate !== null)?.cell ?? null;
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
    const colorOf = edgeColors(colorCache, model, theme);
    const edges = rest;
    renderFlowLayer(canvas, { layout, viewportH, anchors, edges, emphasised: false, retain: false, colorOf, theme });
  }, [restRef, model, layout, viewportH, anchors, rest, theme]);

  useEffect(() => {
    const canvas = focusRef.current;
    if (!canvas || !model) {
      return;
    }
    const colorOf = edgeColors(colorCache, model, theme);
    const edges = focus ?? NO_EDGES;
    renderFlowLayer(canvas, { layout, viewportH, anchors, edges, emphasised: true, retain: true, colorOf, theme });
  }, [focusRef, model, layout, viewportH, anchors, focus, theme]);

  return { active: model !== null, summary, focused: focus !== null };
}
