import React, { useEffect, useMemo, useRef } from 'react';
import { DataFrame, DataQueryRequest, GrafanaTheme2, PanelData } from '@grafana/data';
import {
  FlowEdge,
  FlowModel,
  FlowNodeSummary,
  FlowQueryState,
  buildFlowModel,
  flowBaseEdges,
  flowFocusEdges,
  flowNodeKey,
  flowRefId,
  frameHasRefId,
  resolveFlowConfig,
  summarizeFlowNode,
} from '../data/edges';
import { PanelModel } from '../data/model';
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
  /** Width and height of the visible area of the panel body. */
  viewportW: number;
  viewportH: number;
  theme: GrafanaTheme2;
  /** The cell under the pointer. Its edges are in focus, and the tooltip describes them. */
  hovered: { cell: CellModel } | null;
  /**
   * The cell of the open drilldown popover. Its edges stay in focus while the pointer is elsewhere: off
   * the grid, on the popover, or on a cell that has no edges of its own.
   */
  pinned: { cell: CellModel } | null;
}

export interface FlowOverlayState {
  /** Whether an edge query is named, so that the overlay canvases are to be mounted. */
  active: boolean;
  /** The hovered cell's edges for the tooltip, or null when it has none. */
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

/**
 * The panel model with the flow overlay's warnings after the cells', so that the warning banner shows
 * both. It is the cell model itself while the overlay has nothing to add.
 */
export function withFlowWarnings(model: PanelModel, flow: FlowModel | null): PanelModel {
  return flow && flow.warnings.length > 0 ? { ...model, warnings: [...model.warnings, ...flow.warnings] } : model;
}

/**
 * Whether the query `refId` ran. A query that ran and returned nothing has no frame, so the panel's
 * request decides: its targets that are not hidden are the queries that ran.
 */
export function flowQueryState(
  frames: DataFrame[],
  refId: string,
  request: Pick<DataQueryRequest, 'targets'> | undefined
): FlowQueryState {
  if (frames.length > 0) {
    return 'found';
  }
  if (!request) {
    return 'unknown';
  }
  return (request.targets ?? []).some((target) => target.refId === refId && !target.hide) ? 'found' : 'missing';
}

/**
 * The flow model of the panel, or null when no edge query is named. `data` is the panel's data with all
 * its frames (the edge query's frames are picked by refId) and `root` the hierarchy built from the other
 * queries. It does not depend on the layout, so its warnings are known before the layout is computed.
 */
export function useFlowModel(
  data: Pick<PanelData, 'series' | 'request'>,
  options: FleetGridOptions,
  root: HierarchyNode,
  theme: GrafanaTheme2,
  timeZone: string
): FlowModel | null {
  const { series, request } = data;
  const config = useMemo(() => resolveFlowConfig(options), [options]);
  const refId = config?.refId;
  const frames = useMemo(
    () => (refId === undefined ? NO_FRAMES : series.filter((frame) => frameHasRefId(frame, refId))),
    [series, refId]
  );
  const query = refId === undefined ? 'unknown' : flowQueryState(frames, refId, request);
  return useMemo(
    () => (config ? buildFlowModel(frames, root, options, config, theme, timeZone, query) : null),
    [config, frames, root, options, theme, timeZone, query]
  );
}

// The key of a cell's node when that node has edges, otherwise null.
function nodeWithEdges(model: FlowModel | null, target: { cell: CellModel } | null): string | null {
  if (!model || !target) {
    return null;
  }
  const key = flowNodeKey(model, target.cell);
  return model.byNode.has(key) ? key : null;
}

/**
 * Keeps the two overlay canvases painted. Each stage is memoized on what it reads: a pointer move inside
 * one cell (or between the cells of one group) paints nothing, a change of the focused node paints the
 * focus layer only (the resting layer is dimmed with CSS by the caller), and neither runs the layout or
 * the cell pipeline again.
 */
export function useFlowOverlay(input: FlowOverlayInput): FlowOverlayState {
  const { model, restRef, focusRef, layout, viewportW, viewportH, theme, hovered, pinned } = input;
  const depth = model?.depth ?? 0;
  const anchors = useMemo(() => (depth > 0 ? flowAnchors(layout, depth) : new Map()), [layout, depth]);
  const rest = useMemo(() => (model ? flowBaseEdges(model) : NO_EDGES), [model]);
  // The focus is keyed by the node, not by the cell: the cells of one group share their group's edges.
  // The hovered cell wins. A hovered cell without edges has nothing to show, so it does not take the
  // focus away from the cell of the open popover.
  const hoverKey = nodeWithEdges(model, hovered);
  const focusKey = hoverKey ?? nodeWithEdges(model, pinned);
  const focus = useMemo(
    () => (model && focusKey !== null ? flowFocusEdges(model, [focusKey]) : null),
    [model, focusKey]
  );
  // The tooltip belongs to the hovered cell, so its summary is never that of the popover's cell.
  const summary = useMemo(
    () => (model && hoverKey !== null ? summarizeFlowNode(model, hoverKey) : null),
    [model, hoverKey]
  );
  const colorCache = useRef<ColorCache>({ model: null, theme: null, colors: new Map() });

  useEffect(() => {
    const canvas = restRef.current;
    if (!canvas || !model) {
      return;
    }
    const colorOf = edgeColors(colorCache, model, theme);
    const edges = rest;
    renderFlowLayer(canvas, {
      layout,
      viewportW,
      viewportH,
      anchors,
      edges,
      emphasised: false,
      groupLevel: model.groupLevel,
      retain: false,
      colorOf,
      theme,
    });
  }, [restRef, model, layout, viewportW, viewportH, anchors, rest, theme]);

  useEffect(() => {
    const canvas = focusRef.current;
    if (!canvas || !model) {
      return;
    }
    const colorOf = edgeColors(colorCache, model, theme);
    const edges = focus ?? NO_EDGES;
    renderFlowLayer(canvas, {
      layout,
      viewportW,
      viewportH,
      anchors,
      edges,
      emphasised: true,
      groupLevel: model.groupLevel,
      retain: true,
      colorOf,
      theme,
    });
  }, [focusRef, model, layout, viewportW, viewportH, anchors, focus, theme]);

  return { active: model !== null, summary, focused: focus !== null };
}
