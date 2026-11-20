import { DataFrame, Field, FieldType, GrafanaTheme2 } from '@grafana/data';
import {
  CellModel,
  FleetGridOptions,
  FlowEndpointMapping,
  FlowShowMode,
  FlowWorstDirection,
  HierarchyNode,
  LevelDef,
  NormalizedRow,
  SpatialAggregation,
} from '../types';
import { MetricInfo, buildMetricInfos } from './display';
import { pathKey } from './hierarchy';
import { countFrameRows, normalizeFrames } from './normalize';
import { aggregate } from './values';

// Flow overlay data: one query (the edge query) returns a row per directed pair, and each row is
// resolved to an edge between two hierarchy nodes (cells or groups). Everything here is a pure
// function of the frames, the hierarchy and the options; drawing lives in src/render/flow*.ts.

/** Hard bound on the edge-query rows that are read. Pairwise data grows with the square of the fleet. */
export const MAX_FLOW_ROWS = 20000;
/** Hard bound on the arcs drawn at once. It applies to the resting set and to a focus set alike. */
export const MAX_FLOW_ARCS = 1000;

const EXAMPLE_LIMIT = 3;
// A hop number is a non-negative integer of at most 9 digits, so it is always a safe integer.
const ORDER_RE = /^\d{1,9}$/;

export interface FlowConfig {
  refId: string;
  /** Complete mappings only (hierarchy label, source label and destination label all set). */
  endpoints: FlowEndpointMapping[];
  show: FlowShowMode;
  worst: FlowWorstDirection;
  threshold: number | undefined;
  orderLabel: string;
  pathLabel: string;
}

/** One membership of an edge in a path: the path's name ('' without a path label) and the hop number, if any. */
export interface FlowHop {
  path: string;
  order: number | null;
}

export interface FlowEdge {
  /** pathKey of the hierarchy node the source and the destination resolved to. */
  source: string;
  destination: string;
  /** Spatial aggregation of the rows of this ordered pair; null when none of them has a value. */
  value: number | null;
  /** Number of edge-query rows aggregated into this edge. */
  rowCount: number;
  /** Sorted by path, then by hop number (hops without a number last). */
  hops: FlowHop[];
}

export interface FlowNode {
  key: string;
  path: string[];
  /** The endpoint's raw label values as the edge query reported them, for display. */
  label: string;
}

export interface FlowStats {
  /** Rows the edge query returned, and how many of them were read (at most MAX_FLOW_ROWS). */
  totalRows: number;
  readRows: number;
  /** Rows left out, by reason. They are counted, never drawn as if they were something else. */
  missingLabel: number;
  unmatched: number;
  ambiguous: number;
  selfEdges: number;
  /** Rows whose hop-number label is not a non-negative integer. The edge is kept without a hop number. */
  invalidOrder: number;
  /** Distinct ordered pairs before the threshold filter, and how many of them have no value. */
  edgeCount: number;
  noValue: number;
  /** Up to three endpoints that matched no cell or group, as `label=value`. */
  examples: string[];
}

export interface FlowModel {
  config: FlowConfig;
  /** Number of hierarchy levels in the path of the nodes the endpoints resolve to. */
  depth: number;
  /** Hierarchy label of that level, and whether its nodes are groups rather than cells. */
  levelLabel: string;
  groupLevel: boolean;
  /** The edges that pass the threshold filter, worst first. Indexes below point into this list. */
  edges: FlowEdge[];
  nodes: Map<string, FlowNode>;
  /** Node key → its edges (both directions), worst first. Makes hover independent of the edge count. */
  byNode: Map<string, number[]>;
  /** Path name → its edges in hop order. */
  byPath: Map<string, number[]>;
  stats: FlowStats;
  warnings: string[];
  /** Standard field config of the edge query (unit, thresholds, color scheme). Absent without a numeric field. */
  metricInfo?: MetricInfo;
}

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** refId of the edge query, or '' when the overlay is off. */
export function flowRefId(options: Pick<FleetGridOptions, 'flowRefId'>): string {
  return isBlank(options.flowRefId) ? '' : (options.flowRefId as string);
}

/** Whether a frame belongs to the query `refId` (a frame without a refId counts as 'A', as in normalizeFrames). */
export const frameHasRefId = (frame: DataFrame, refId: string): boolean => (frame.refId ?? 'A') === refId;

/** Normalizes the persisted options. Returns null when the overlay is off (no edge query is named). */
export function resolveFlowConfig(options: FleetGridOptions): FlowConfig | null {
  const refId = flowRefId(options);
  if (refId === '') {
    return null;
  }
  const endpoints = (Array.isArray(options.flowEndpoints) ? options.flowEndpoints : []).filter(
    (m) => m && !isBlank(m.level) && !isBlank(m.source) && !isBlank(m.destination)
  );
  const threshold = options.flowThreshold;
  return {
    refId,
    endpoints,
    show: options.flowShow === 'hover' ? 'hover' : 'always',
    worst: options.flowWorst === 'low' ? 'low' : 'high',
    threshold: typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : undefined,
    orderLabel: isBlank(options.flowOrderLabel) ? '' : (options.flowOrderLabel as string),
    pathLabel: isBlank(options.flowPathLabel) ? '' : (options.flowPathLabel as string),
  };
}

export interface EndpointIndex {
  depth: number;
  /** JSON of the mapped raw label values → node key; null when two nodes carry the same values. */
  byValues: Map<string, string | null>;
  paths: Map<string, string[]>;
}

/**
 * Index from the raw values of the mapped hierarchy labels to the hierarchy node that carries them.
 * Endpoints resolve at the deepest mapped level: mapping only `host` under zone → host → gpu resolves to
 * the host group. Values are compared raw (before the level's extraction), because an extracted key such
 * as a trailing number is unique only inside its parent.
 */
export function buildEndpointIndex(
  root: HierarchyNode,
  levels: LevelDef[],
  endpoints: FlowEndpointMapping[]
): EndpointIndex {
  let depth = 0;
  for (const mapping of endpoints) {
    depth = Math.max(depth, levels.map((l) => l.label).lastIndexOf(mapping.level) + 1);
  }
  const index: EndpointIndex = { depth, byValues: new Map(), paths: new Map() };
  const visit = (node: HierarchyNode) => {
    if (node.cell) {
      indexCell(index, node.cell, endpoints);
    }
    node.children.forEach(visit);
  };
  if (depth > 0) {
    visit(root);
  }
  return index;
}

function indexCell(index: EndpointIndex, cell: CellModel, endpoints: FlowEndpointMapping[]): void {
  const path = cell.path.slice(0, index.depth);
  const key = pathKey(path);
  for (const labelSet of cell.labelSets ?? [cell.labels]) {
    const values = endpoints.map((m) => labelSet[m.level]);
    if (values.some((value) => value === undefined)) {
      continue;
    }
    const valuesKey = JSON.stringify(values);
    const known = index.byValues.get(valuesKey);
    if (known === undefined) {
      index.byValues.set(valuesKey, key);
      index.paths.set(key, path);
    } else if (known !== key) {
      index.byValues.set(valuesKey, null);
    }
  }
}

interface Bucket {
  source: string;
  destination: string;
  values: number[];
  rowCount: number;
  hops: Map<string, FlowHop>;
}

interface Collector {
  index: EndpointIndex;
  config: FlowConfig;
  sourceLabels: string[];
  destinationLabels: string[];
  buckets: Map<string, Bucket>;
  nodes: Map<string, FlowNode>;
  stats: FlowStats;
}

type EndpointFailure = 'missingLabel' | 'unmatched' | 'ambiguous';

interface ResolvedEndpoint {
  key: string;
  label: string;
}

// Resolves one side of a row to a hierarchy node, or says why it cannot be resolved.
function resolveEndpoint(
  c: Collector,
  labels: Record<string, string>,
  names: string[]
): ResolvedEndpoint | EndpointFailure {
  const values = names.map((name) => labels[name]);
  if (values.some((value) => value === undefined || value === '')) {
    return 'missingLabel';
  }
  const key = c.index.byValues.get(JSON.stringify(values));
  if (key === undefined) {
    const example = names.map((name, i) => `${name}=${values[i]}`).join(', ');
    if (c.stats.examples.length < EXAMPLE_LIMIT && !c.stats.examples.includes(example)) {
      c.stats.examples.push(example);
    }
    return 'unmatched';
  }
  return key === null ? 'ambiguous' : { key, label: values.join(' / ') };
}

// A row that cannot be drawn is counted once, by the first of these reasons that applies to either side.
const FAILURE_ORDER: EndpointFailure[] = ['missingLabel', 'unmatched', 'ambiguous'];

function rowFailure(
  source: ResolvedEndpoint | EndpointFailure,
  destination: ResolvedEndpoint | EndpointFailure
): EndpointFailure | null {
  return FAILURE_ORDER.find((failure) => source === failure || destination === failure) ?? null;
}

function registerNode(c: Collector, endpoint: ResolvedEndpoint): void {
  if (!c.nodes.has(endpoint.key)) {
    c.nodes.set(endpoint.key, {
      key: endpoint.key,
      path: c.index.paths.get(endpoint.key) ?? [],
      label: endpoint.label,
    });
  }
}

// The row's membership in a path, or null when it carries neither a path name nor a hop number.
function rowHop(c: Collector, labels: Record<string, string>): FlowHop | null {
  const { orderLabel, pathLabel } = c.config;
  const path = pathLabel === '' ? undefined : labels[pathLabel];
  const rawOrder = orderLabel === '' ? undefined : labels[orderLabel];
  let order: number | null = null;
  if (rawOrder !== undefined && rawOrder !== '') {
    if (ORDER_RE.test(rawOrder)) {
      order = Number(rawOrder);
    } else {
      c.stats.invalidOrder++;
    }
  }
  const named = path !== undefined && path !== '';
  return named || order !== null ? { path: named ? path : '', order } : null;
}

function addRow(c: Collector, row: NormalizedRow): void {
  const source = resolveEndpoint(c, row.labels, c.sourceLabels);
  const destination = resolveEndpoint(c, row.labels, c.destinationLabels);
  const failure = rowFailure(source, destination);
  if (failure !== null || typeof source === 'string' || typeof destination === 'string') {
    if (failure !== null) {
      c.stats[failure]++;
    }
    return;
  }
  if (source.key === destination.key) {
    c.stats.selfEdges++;
    return;
  }
  registerNode(c, source);
  registerNode(c, destination);
  const key = `${source.key}\0${destination.key}`;
  let bucket = c.buckets.get(key);
  if (!bucket) {
    bucket = { source: source.key, destination: destination.key, values: [], rowCount: 0, hops: new Map() };
    c.buckets.set(key, bucket);
  }
  bucket.rowCount++;
  // A row without a finite value still proves the pair exists; it adds no number (unknown is not 0).
  if (row.value !== null) {
    bucket.values.push(row.value);
  }
  const hop = rowHop(c, row.labels);
  if (hop) {
    bucket.hops.set(`${hop.path}\0${hop.order}`, hop);
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareHops(a: FlowHop, b: FlowHop): number {
  return compareText(a.path, b.path) || (a.order ?? Infinity) - (b.order ?? Infinity);
}

function compareOrder(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  return b === null ? -1 : a - b;
}

/**
 * Edges between hierarchy nodes from normalized edge-query rows. Rows of the same ordered pair are one
 * edge whose value is their spatial aggregation; A→B and B→A are two edges. A pair whose two ends resolve
 * to the same node is a self-edge: it has no arc and is only counted.
 */
export function collectFlowEdges(
  rows: NormalizedRow[],
  index: EndpointIndex,
  config: FlowConfig,
  agg: SpatialAggregation
): { edges: FlowEdge[]; nodes: Map<string, FlowNode>; stats: FlowStats } {
  const c: Collector = {
    index,
    config,
    sourceLabels: config.endpoints.map((m) => m.source),
    destinationLabels: config.endpoints.map((m) => m.destination),
    buckets: new Map(),
    nodes: new Map(),
    stats: {
      totalRows: rows.length,
      readRows: rows.length,
      missingLabel: 0,
      unmatched: 0,
      ambiguous: 0,
      selfEdges: 0,
      invalidOrder: 0,
      edgeCount: 0,
      noValue: 0,
      examples: [],
    },
  };
  for (const row of rows) {
    addRow(c, row);
  }
  const edges: FlowEdge[] = [];
  for (const bucket of c.buckets.values()) {
    const value = bucket.values.length > 0 ? aggregate(bucket.values, agg) : null;
    edges.push({
      source: bucket.source,
      destination: bucket.destination,
      // An aggregate can leave the finite range (a sum that overflows); that is unknown too.
      value: value !== null && Number.isFinite(value) ? value : null,
      rowCount: bucket.rowCount,
      hops: [...bucket.hops.values()].sort(compareHops),
    });
  }
  c.stats.edgeCount = edges.length;
  c.stats.noValue = edges.filter((edge) => edge.value === null).length;
  return { edges, nodes: c.nodes, stats: c.stats };
}

// Worst first: by value in the worse direction, edges without a value last, then by endpoints so that
// the order (and with it which edges win the draw bound) never depends on the order of the query result.
function compareWorstFirst(worst: FlowWorstDirection): (a: FlowEdge, b: FlowEdge) => number {
  return (a, b) => {
    if (a.value !== b.value) {
      if (a.value === null) {
        return 1;
      }
      if (b.value === null) {
        return -1;
      }
      return worst === 'high' ? b.value - a.value : a.value - b.value;
    }
    return compareText(a.source, b.source) || compareText(a.destination, b.destination);
  };
}

/**
 * The edges to consider for drawing, worst first. With a threshold only the edges strictly worse than it
 * remain: above it when higher is worse, below it when lower is worse. An edge without a value cannot be
 * compared, so a threshold leaves it out.
 */
export function selectFlowEdges(
  edges: FlowEdge[],
  worst: FlowWorstDirection,
  threshold: number | undefined
): FlowEdge[] {
  const kept =
    threshold === undefined
      ? [...edges]
      : edges.filter(
          (edge) => edge.value !== null && (worst === 'high' ? edge.value > threshold : edge.value < threshold)
        );
  return kept.sort(compareWorstFirst(worst));
}

function buildFlowIndex(edges: FlowEdge[]): Pick<FlowModel, 'byNode' | 'byPath'> {
  const byNode = new Map<string, number[]>();
  const hopsByPath = new Map<string, Array<{ index: number; order: number | null }>>();
  const push = (key: string, index: number) => {
    const list = byNode.get(key);
    if (list) {
      list.push(index);
    } else {
      byNode.set(key, [index]);
    }
  };
  edges.forEach((edge, index) => {
    push(edge.source, index);
    push(edge.destination, index);
    for (const hop of edge.hops) {
      const list = hopsByPath.get(hop.path) ?? [];
      list.push({ index, order: hop.order });
      hopsByPath.set(hop.path, list);
    }
  });
  const byPath = new Map<string, number[]>();
  for (const [path, hops] of hopsByPath) {
    hops.sort((a, b) => compareOrder(a.order, b.order) || a.index - b.index);
    byPath.set(path, [...new Set(hops.map((hop) => hop.index))]);
  }
  return { byNode, byPath };
}

// Whether a field of a table frame is a column (as opposed to a labeled series value).
const isLabelColumn = (field: Field): boolean =>
  field.type === FieldType.string ||
  (field.type === FieldType.number && !(field.labels && Object.keys(field.labels).length > 0));

// The edge query's label columns as text. A table column that carries a flow label can be numeric (a hop
// number, a rank or an ID): normalizeFrames reads labels from string columns only and would take such a
// column as the value. An empty cell becomes '' (no label) instead of the text "null". Only the rows that
// can be read are converted.
function flowLabelColumns(frames: DataFrame[], names: Set<string>, maxRows: number): DataFrame[] {
  return frames.map((frame) => {
    const isFlowLabel = (field: Field) => names.has(field.name) && isLabelColumn(field);
    if (!frame.fields.some(isFlowLabel)) {
      return frame;
    }
    return {
      ...frame,
      fields: frame.fields.map((field) =>
        isFlowLabel(field)
          ? {
              ...field,
              type: FieldType.string,
              values: field.values.slice(0, maxRows).map((value) => (value == null ? '' : String(value))),
            }
          : field
      ),
    };
  });
}

function flowLabelNames(config: FlowConfig): Set<string> {
  const names = new Set<string>();
  for (const mapping of config.endpoints) {
    names.add(mapping.source);
    names.add(mapping.destination);
  }
  for (const name of [config.orderLabel, config.pathLabel]) {
    if (name !== '') {
      names.add(name);
    }
  }
  return names;
}

function excludedWarning(stats: FlowStats): string | null {
  const excluded = stats.missingLabel + stats.unmatched + stats.ambiguous;
  if (excluded === 0) {
    return null;
  }
  const reasons = [
    stats.missingLabel > 0 ? `${stats.missingLabel} without an endpoint label` : '',
    stats.unmatched > 0 ? `${stats.unmatched} with an endpoint that matches no cell or group` : '',
    stats.ambiguous > 0 ? `${stats.ambiguous} with an endpoint that matches more than one` : '',
  ].filter((reason) => reason !== '');
  const examples = stats.examples.length > 0 ? `; for example ${stats.examples.join('; ')}` : '';
  return `Flow overlay: ${excluded}/${stats.readRows} edge rows were left out (${reasons.join(', ')}${examples})`;
}

function flowWarnings(config: FlowConfig, stats: FlowStats): string[] {
  const warnings: string[] = [];
  if (stats.totalRows === 0) {
    warnings.push(`Flow overlay: query "${config.refId}" returned no rows`);
  }
  if (stats.readRows < stats.totalRows) {
    warnings.push(
      `Flow overlay: read the first ${stats.readRows} of ${stats.totalRows} edge rows; narrow query "${config.refId}" (for example with topk)`
    );
  }
  const excluded = excludedWarning(stats);
  if (excluded) {
    warnings.push(excluded);
  }
  if (stats.invalidOrder > 0) {
    warnings.push(
      `Flow overlay: ${stats.invalidOrder} edge rows have a "${config.orderLabel}" value that is not a whole number`
    );
  }
  return warnings;
}

function emptyModel(config: FlowConfig, warnings: string[]): FlowModel {
  return {
    config,
    depth: 0,
    levelLabel: '',
    groupLevel: false,
    edges: [],
    nodes: new Map(),
    byNode: new Map(),
    byPath: new Map(),
    stats: {
      totalRows: 0,
      readRows: 0,
      missingLabel: 0,
      unmatched: 0,
      ambiguous: 0,
      selfEdges: 0,
      invalidOrder: 0,
      edgeCount: 0,
      noValue: 0,
      examples: [],
    },
    warnings,
  };
}

function configWarnings(config: FlowConfig, levels: LevelDef[], allMappings: number): string[] {
  const warnings: string[] = [];
  const levelLabels = new Set(levels.map((level) => level.label));
  const unknown = config.endpoints.filter((m) => !levelLabels.has(m.level)).map((m) => `"${m.level}"`);
  if (unknown.length > 0) {
    warnings.push(`Flow overlay: endpoint mapping ${[...new Set(unknown)].join(', ')} is not a hierarchy label`);
  } else if (config.endpoints.length === 0) {
    warnings.push(
      allMappings > 0
        ? 'Flow overlay: every endpoint mapping needs a hierarchy label, a source label and a destination label'
        : 'Flow overlay: map at least one hierarchy label to a source and a destination label of the edge query'
    );
  }
  return warnings;
}

function edgeValueRange(edges: FlowEdge[]): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const edge of edges) {
    if (edge.value !== null) {
      min = Math.min(min, edge.value);
      max = Math.max(max, edge.value);
    }
  }
  return Number.isFinite(min) ? { min, max } : undefined;
}

/**
 * The flow overlay's model: the edge query's rows resolved against the hierarchy, filtered, ranked and
 * indexed for hover. `frames` are the frames of the edge query only. A configuration that cannot work
 * (no usable endpoint mapping) yields an empty model and a warning rather than a guess.
 */
export function buildFlowModel(
  frames: DataFrame[],
  root: HierarchyNode,
  options: FleetGridOptions,
  config: FlowConfig,
  theme: GrafanaTheme2,
  timeZone: string
): FlowModel {
  const levels = options.levels;
  const invalid = configWarnings(config, levels, options.flowEndpoints?.length ?? 0);
  if (invalid.length > 0) {
    return emptyModel(config, invalid);
  }
  const labelFrames = flowLabelColumns(frames, flowLabelNames(config), MAX_FLOW_ROWS);
  const rows = normalizeFrames(labelFrames, options.reduceCalc || 'lastNotNull', MAX_FLOW_ROWS);
  const index = buildEndpointIndex(root, levels, config.endpoints);
  const collected = collectFlowEdges(rows, index, config, options.spatialAggregation);
  const stats: FlowStats = { ...collected.stats, totalRows: countFrameRows(labelFrames) };
  const edges = selectFlowEdges(collected.edges, config.worst, config.threshold);
  // Like the cells, the automatic color range follows the values that can be displayed. Passing a range
  // and a single frame also keeps buildMetricInfos from scanning every value of an oversized result.
  const valueFrame = labelFrames.find((frame) => frame.fields.some((field) => field.type === FieldType.number));
  const range = edgeValueRange(edges) ?? { min: 0, max: 1 };
  const metricInfo = valueFrame
    ? buildMetricInfos([valueFrame], theme, timeZone, new Map([[valueFrame.refId ?? 'A', range]]))[0]
    : undefined;
  return {
    config,
    depth: index.depth,
    levelLabel: levels[index.depth - 1]?.label ?? '',
    groupLevel: index.depth < levels.length,
    edges,
    nodes: collected.nodes,
    ...buildFlowIndex(edges),
    stats,
    warnings: flowWarnings(config, stats),
    metricInfo,
  };
}

/** Key of the node that a cell's flows are attached to: the cell itself, or its group at the endpoint level. */
export function flowNodeKey(model: FlowModel, cell: CellModel): string {
  return pathKey(cell.path.slice(0, model.depth));
}

/** The arcs drawn while nothing is focused: the worst MAX_FLOW_ARCS edges, or none in hover mode. */
export function flowBaseEdges(model: FlowModel): FlowEdge[] {
  return model.config.show === 'hover' ? [] : model.edges.slice(0, MAX_FLOW_ARCS);
}

/**
 * The edges to emphasise for a set of node keys (today the hovered cell's node; a selection can pass
 * several): every edge that touches one of the nodes, then the other edges of the paths those edges are
 * on, so that pointing at one member of a ring shows the whole ring. Returns null when the nodes have no
 * edge, so that an unrelated cell does not dim the overlay. At most MAX_FLOW_ARCS edges, worst first;
 * the cost depends on the edges found, not on the number of edges in the model.
 */
export function flowFocusEdges(model: FlowModel, nodeKeys: string[]): FlowEdge[] | null {
  const picked = new Set<number>();
  const add = (indexes: number[] | undefined) => {
    for (const index of indexes ?? []) {
      if (picked.size >= MAX_FLOW_ARCS) {
        return;
      }
      picked.add(index);
    }
  };
  for (const key of nodeKeys) {
    add(model.byNode.get(key));
  }
  if (picked.size === 0) {
    return null;
  }
  const paths = new Set<string>();
  for (const index of picked) {
    model.edges[index].hops.forEach((hop) => paths.add(hop.path));
  }
  for (const path of paths) {
    add(model.byPath.get(path));
  }
  return [...picked].sort((a, b) => a - b).map((index) => model.edges[index]);
}

export interface FlowNodeHop extends FlowHop {
  direction: 'out' | 'in';
}

export interface FlowNodeSummary {
  node: FlowNode;
  outCount: number;
  inCount: number;
  /** Distinct nodes at the other end of the node's edges. */
  peerCount: number;
  /** The node's worst edge, the node at its other end, and whether it leaves ('out') or enters the node. */
  worst: { edge: FlowEdge; peer: FlowNode | undefined; direction: 'out' | 'in' };
  /** The node's hops on ordered paths, sorted by path and hop number. */
  hops: FlowNodeHop[];
}

/** What the tooltip says about a node's edges, or null when it has none that pass the filter. */
export function summarizeFlowNode(model: FlowModel, nodeKey: string): FlowNodeSummary | null {
  const indexes = model.byNode.get(nodeKey);
  const node = model.nodes.get(nodeKey);
  if (!indexes || indexes.length === 0 || !node) {
    return null;
  }
  const peers = new Set<string>();
  const hops: FlowNodeHop[] = [];
  let outCount = 0;
  for (const index of indexes) {
    const edge = model.edges[index];
    const direction = edge.source === nodeKey ? 'out' : 'in';
    outCount += direction === 'out' ? 1 : 0;
    peers.add(direction === 'out' ? edge.destination : edge.source);
    edge.hops.forEach((hop) => hops.push({ ...hop, direction }));
  }
  // byNode lists are in the model's worst-first order, so the first entry is the node's worst edge.
  const worstEdge = model.edges[indexes[0]];
  const worstDirection = worstEdge.source === nodeKey ? 'out' : 'in';
  return {
    node,
    outCount,
    inCount: indexes.length - outCount,
    peerCount: peers.size,
    worst: {
      edge: worstEdge,
      peer: model.nodes.get(worstDirection === 'out' ? worstEdge.destination : worstEdge.source),
      direction: worstDirection,
    },
    hops: hops.sort((a, b) => compareHops(a, b) || compareText(a.direction, b.direction)),
  };
}
