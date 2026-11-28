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
} from '../types';
import { MetricInfo, buildMetricInfos } from './display';
import { pathKey } from './hierarchy';
import { countFrameRows, forEachRowValue, isTableFrame, normalizeFrames } from './normalize';

// Flow overlay data: one query (the edge query) returns a row per directed pair, and each row is
// resolved to an edge between two hierarchy nodes (cells or groups). Everything here is a pure
// function of the frames, the hierarchy and the options; drawing lives in src/render/flow*.ts.

/**
 * Hard bound on the edge-query rows that are resolved into edges. Pairwise data grows with the square of
 * the fleet. Of a larger result only the value of each row is read, to find the worst MAX_FLOW_ROWS.
 */
export const MAX_FLOW_ROWS = 20000;
/**
 * Hard bound on the arcs drawn at once. It is the bound of a focus set, and the most that the resting set
 * can be set to.
 */
export const MAX_FLOW_ARCS = 500;
/**
 * Arcs drawn at rest unless the option says otherwise. A few hundred arcs bury the cells under them and
 * each other, so the worst edge is no easier to find than without the overlay (docs/design.md §15).
 */
export const DEFAULT_FLOW_REST_ARCS = 100;

const EXAMPLE_LIMIT = 3;
// A hop number is a non-negative integer of at most 9 digits, so it is always a safe integer.
const ORDER_RE = /^\d{1,9}$/;

export interface FlowConfig {
  refId: string;
  /** Complete mappings only (hierarchy label, source label and destination label all set). */
  endpoints: FlowEndpointMapping[];
  /** Number of stored mappings that are not complete. Any of them stops the overlay: see configWarnings. */
  incompleteEndpoints: number;
  show: FlowShowMode;
  /** The most arcs drawn while nothing is in focus: 1 to MAX_FLOW_ARCS. */
  restArcs: number;
  worst: FlowWorstDirection;
  threshold: number | undefined;
  orderLabel: string;
  pathLabel: string;
}

/**
 * Whether the edge query ran. `missing`: the panel's request has no visible query with the refId (it
 * does not exist or is hidden). `unknown`: there is no frame and no request to tell from.
 */
export type FlowQueryState = 'found' | 'missing' | 'unknown';

/** One membership of an edge in a path: the path's name ('' without a path label) and the hop number, if any. */
export interface FlowHop {
  path: string;
  order: number | null;
}

export interface FlowEdge {
  /** pathKey of the hierarchy node the source and the destination resolved to. */
  source: string;
  destination: string;
  /** The worst value among the rows of this ordered pair; null when none of them has a value. */
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
  /** Rows the edge query returned, and how many of them were resolved (the worst MAX_FLOW_ROWS at most). */
  totalRows: number;
  readRows: number;
  /** Rows left out, by reason. They are counted, never drawn as if they were something else. */
  missingLabel: number;
  unmatched: number;
  ambiguous: number;
  selfEdges: number;
  /**
   * The worst value among the rows left out for one of the three reasons above, and among the self-edges;
   * null when none of them has a value. A degraded row that cannot be drawn is still reported.
   */
  excludedWorst: number | null;
  selfWorst: number | null;
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
  /**
   * The edges that pass the threshold filter, worst first: first the `valuedCount` edges with a value,
   * then the edges without one. Indexes below point into this list.
   */
  edges: FlowEdge[];
  valuedCount: number;
  nodes: Map<string, FlowNode>;
  /** Node key → its edges (both directions), worst first. Makes hover independent of the edge count. */
  byNode: Map<string, number[]>;
  /** Path name → its edges in hop order. */
  byPath: Map<string, number[]>;
  stats: FlowStats;
  warnings: string[];
  /**
   * Why nothing can be drawn, in a few words, or null. The warning says the same at length; this text is
   * for the legend, which stays readable in a panel that is too narrow for the warning banner.
   */
  error: string | null;
  /** Standard field config of the edge query (unit, thresholds, color scheme). Absent without a numeric field. */
  metricInfo?: MetricInfo;
}

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';
// A name typed into an option, without the spaces around it: 'E ' names query E.
const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** refId of the edge query, or '' when the overlay is off. */
export function flowRefId(options: Pick<FleetGridOptions, 'flowRefId'>): string {
  return trimmed(options.flowRefId);
}

/** Whether a frame belongs to the query `refId` (a frame without a refId counts as 'A', as in normalizeFrames). */
export const frameHasRefId = (frame: DataFrame, refId: string): boolean => (frame.refId ?? 'A') === refId;

/**
 * The number of arcs at rest that an option value stands for: a whole number from 1 to MAX_FLOW_ARCS, or
 * the default for anything that is not a finite number. The editor stores this number, and a value that
 * was stored by hand is read through it.
 */
export function normalizeFlowRestArcs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_FLOW_ARCS, Math.max(1, Math.round(value)))
    : DEFAULT_FLOW_REST_ARCS;
}

/** Normalizes the persisted options. Returns null when the overlay is off (no edge query is named). */
export function resolveFlowConfig(options: FleetGridOptions): FlowConfig | null {
  const refId = flowRefId(options);
  if (refId === '') {
    return null;
  }
  const stored = Array.isArray(options.flowEndpoints) ? options.flowEndpoints : [];
  // The hierarchy label is compared as it is stored in the levels; the names of the edge query's labels
  // are typed in and lose the spaces around them.
  const endpoints = stored
    .filter((m) => m && !isBlank(m.level) && !isBlank(m.source) && !isBlank(m.destination))
    .map((m) => ({ level: m.level, source: m.source.trim(), destination: m.destination.trim() }));
  const threshold = options.flowThreshold;
  return {
    refId,
    endpoints,
    incompleteEndpoints: stored.length - endpoints.length,
    show: options.flowShow === 'hover' ? 'hover' : 'always',
    restArcs: normalizeFlowRestArcs(options.flowRestArcs),
    worst: options.flowWorst === 'low' ? 'low' : 'high',
    threshold: typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : undefined,
    orderLabel: trimmed(options.flowOrderLabel),
    pathLabel: trimmed(options.flowPathLabel),
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
  /** The worst finite value seen so far; null while no row had one. */
  value: number | null;
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

// A label of a row by a user-configured name. Only the row's own labels count, so a name such as
// "constructor" does not read a property of every object.
const ownLabel = (labels: Record<string, string>, name: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(labels, name) ? labels[name] : undefined;

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
  const values = names.map((name) => ownLabel(labels, name));
  if (values.some((value) => value === undefined || value === '')) {
    return 'missingLabel';
  }
  const key = c.index.byValues.get(JSON.stringify(values));
  if (key === undefined) {
    return 'unmatched';
  }
  return key === null ? 'ambiguous' : { key, label: values.join(' / ') };
}

// Keeps up to EXAMPLE_LIMIT distinct endpoints of rows that were counted as unmatched, as `label=value`.
function recordUnmatched(c: Collector, labels: Record<string, string>, names: string[]): void {
  const example = names.map((name) => `${name}=${ownLabel(labels, name)}`).join(', ');
  if (c.stats.examples.length < EXAMPLE_LIMIT && !c.stats.examples.includes(example)) {
    c.stats.examples.push(example);
  }
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
  const path = pathLabel === '' ? undefined : ownLabel(labels, pathLabel);
  const rawOrder = orderLabel === '' ? undefined : ownLabel(labels, orderLabel);
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

// The worse of a value seen so far (null: none yet) and the value of one more row (null: it has none).
function worseSoFar(seen: number | null, value: number | null, worst: FlowWorstDirection): number | null {
  if (value === null) {
    return seen;
  }
  return seen === null ? value : worseValue(seen, value, worst);
}

function addRow(c: Collector, row: NormalizedRow): void {
  const source = resolveEndpoint(c, row.labels, c.sourceLabels);
  const destination = resolveEndpoint(c, row.labels, c.destinationLabels);
  const failure = rowFailure(source, destination);
  if (failure !== null || typeof source === 'string' || typeof destination === 'string') {
    if (failure !== null) {
      c.stats[failure]++;
    }
    if (failure === 'unmatched') {
      recordUnmatched(c, row.labels, source === 'unmatched' ? c.sourceLabels : c.destinationLabels);
    }
    c.stats.excludedWorst = worseSoFar(c.stats.excludedWorst, row.value, c.config.worst);
    return;
  }
  if (source.key === destination.key) {
    c.stats.selfEdges++;
    c.stats.selfWorst = worseSoFar(c.stats.selfWorst, row.value, c.config.worst);
    return;
  }
  registerNode(c, source);
  registerNode(c, destination);
  const key = `${source.key}\0${destination.key}`;
  let bucket = c.buckets.get(key);
  if (!bucket) {
    bucket = { source: source.key, destination: destination.key, value: null, rowCount: 0, hops: new Map() };
    c.buckets.set(key, bucket);
  }
  bucket.rowCount++;
  // A row without a finite value still proves the pair exists; it adds no number (unknown is not 0).
  bucket.value = worseSoFar(bucket.value, row.value, c.config.worst);
  const hop = rowHop(c, row.labels);
  if (hop) {
    bucket.hops.set(`${hop.path}\0${hop.order}`, hop);
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Hop numbers ascending; a hop without a number comes last.
function compareOrder(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  return b === null ? -1 : a - b;
}

function compareHops(a: FlowHop, b: FlowHop): number {
  return compareText(a.path, b.path) || compareOrder(a.order, b.order);
}

/** The worse of two values: the higher one when higher is worse, the lower one when lower is worse. */
export function worseValue(a: number, b: number, worst: FlowWorstDirection): number {
  return worst === 'high' ? Math.max(a, b) : Math.min(a, b);
}

/**
 * Edges between hierarchy nodes from normalized edge-query rows. Rows of the same ordered pair are one
 * edge whose value is the worst of them (`config.worst`), so that one degraded row among healthy ones
 * (one RNIC pair of a host pair) is what the edge shows. The cells' spatial aggregation is not used: a
 * mean would dilute the degraded row and a maximum would hide it when lower is worse. A→B and B→A are two
 * edges. A pair whose two ends resolve to the same node is a self-edge: it has no arc and is only counted.
 */
export function collectFlowEdges(
  rows: NormalizedRow[],
  index: EndpointIndex,
  config: FlowConfig
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
      excludedWorst: null,
      selfWorst: null,
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
    edges.push({
      source: bucket.source,
      destination: bucket.destination,
      value: bucket.value,
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

// The edge query's label columns, typed as labels. A table column that carries a flow label can be
// numeric (a hop number, a rank or an ID): normalizeFrames reads labels from string columns only and
// would take such a column as the value. Only the type changes here; no value is read.
function flowLabelColumns(frames: DataFrame[], names: Set<string>): DataFrame[] {
  return frames.map((frame) => {
    const isFlowLabel = (field: Field) => names.has(field.name) && isLabelColumn(field);
    if (!frame.fields.some(isFlowLabel)) {
      return frame;
    }
    return {
      ...frame,
      fields: frame.fields.map((field) => (isFlowLabel(field) ? { ...field, type: FieldType.string } : field)),
    };
  });
}

// The values of the label columns as text, for the rows that are resolved. An empty cell becomes ''
// (no label) instead of the text "null".
function flowLabelText(frames: DataFrame[], names: Set<string>): DataFrame[] {
  return frames.map((frame) => {
    const isFlowLabel = (field: Field) => names.has(field.name) && field.type === FieldType.string;
    if (!frame.fields.some(isFlowLabel)) {
      return frame;
    }
    return {
      ...frame,
      fields: frame.fields.map((field) =>
        isFlowLabel(field)
          ? { ...field, values: field.values.map((value) => (value == null ? '' : String(value))) }
          : field
      ),
    };
  });
}

// A frame reduced to some of its rows: rows of a table frame by row number, series by their position
// among the frame's numeric fields (the row numbering of forEachRowValue).
function pickRows(frame: DataFrame, picked: number[]): DataFrame {
  if (isTableFrame(frame)) {
    return {
      ...frame,
      length: picked.length,
      fields: frame.fields.map((field) => ({ ...field, values: picked.map((row) => field.values[row]) })),
    };
  }
  const keep = new Set(picked);
  let position = -1;
  return {
    ...frame,
    fields: frame.fields.filter((field) => field.type !== FieldType.number || keep.has(++position)),
  };
}

// The `size` smallest of the numbers that are offered, kept in a binary max-heap: `top()` is the largest
// of them. Finding the worst rows of a result this way costs O(n log size) for any order of the rows, and
// a row that is not among the worst so far costs one comparison.
class SmallestKeys {
  private readonly heap: Float64Array;
  private count = 0;

  constructor(private readonly size: number) {
    this.heap = new Float64Array(size);
  }

  top(): number {
    return this.count < this.size ? Infinity : this.heap[0];
  }

  offer(key: number): void {
    const heap = this.heap;
    if (this.count < this.size) {
      // Sift up.
      let i = this.count++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent] >= key) {
          break;
        }
        heap[i] = heap[parent];
        i = parent;
      }
      heap[i] = key;
      return;
    }
    if (key >= heap[0]) {
      return;
    }
    // Replace the largest and sift down.
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) {
        break;
      }
      if (child + 1 < this.size && heap[child + 1] > heap[child]) {
        child++;
      }
      if (heap[child] <= key) {
        break;
      }
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = key;
  }
}

// One entry per row of the edge query, in the order of the result.
interface RowKeys {
  frameOf: Int32Array;
  rowOf: Int32Array;
  /** Rank key of each row: ascending is worst first; NaN marks a row without a value. */
  keys: Float64Array;
  count: number;
  unknown: number;
}

function readRowKeys(frames: DataFrame[], reduceCalc: string, worst: FlowWorstDirection, total: number): RowKeys {
  const read: RowKeys = {
    frameOf: new Int32Array(total),
    rowOf: new Int32Array(total),
    keys: new Float64Array(total),
    count: 0,
    unknown: 0,
  };
  const sign = worst === 'high' ? -1 : 1;
  frames.forEach((frame, frameIndex) =>
    forEachRowValue(frame, reduceCalc, (row, value) => {
      read.frameOf[read.count] = frameIndex;
      read.rowOf[read.count] = row;
      read.keys[read.count] = value === null ? NaN : sign * value;
      read.unknown += value === null ? 1 : 0;
      read.count++;
    })
  );
  return read;
}

// The key of the least bad of the `size` worst rows, and how many rows are strictly worse than it.
function worstCutoff(keys: Float64Array, count: number, size: number): { cutoff: number; below: number } {
  if (size <= 0) {
    return { cutoff: -Infinity, below: 0 };
  }
  const smallest = new SmallestKeys(size);
  for (let i = 0; i < count; i++) {
    // A NaN key (no value) fails the comparison and is never offered.
    if (keys[i] < smallest.top()) {
      smallest.offer(keys[i]);
    }
  }
  const cutoff = smallest.top();
  let below = 0;
  for (let i = 0; i < count; i++) {
    below += keys[i] < cutoff ? 1 : 0;
  }
  return { cutoff, below };
}

/**
 * The frames reduced to the `bound` rows that are resolved when the edge query returns more (`total`
 * rows): the worst rows by value, not the first ones, so that the worst edge is found wherever it is in
 * the result. The value of every row is read once (one number per table row, one reduction per series);
 * nothing else is built for the rows that are left out. Rows without a value share the bound like arcs
 * do (shareFlowBound). Rows that tie with the least bad row that is kept are taken in the order of the
 * result.
 */
export function selectWorstRows(
  frames: DataFrame[],
  reduceCalc: string,
  worst: FlowWorstDirection,
  total: number,
  bound: number
): DataFrame[] {
  const { frameOf, rowOf, keys, count, unknown } = readRowKeys(frames, reduceCalc, worst, total);
  const share = shareFlowBound(count - unknown, unknown, bound);
  const { cutoff, below } = worstCutoff(keys, count, share.valued);
  let ties = share.valued - below;
  let unknownLeft = share.unknown;
  const picked = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const key = keys[i];
    const take = Number.isNaN(key) ? unknownLeft-- > 0 : key < cutoff || (key === cutoff && ties-- > 0);
    if (!take) {
      continue;
    }
    const rows = picked.get(frameOf[i]);
    if (rows) {
      rows.push(rowOf[i]);
    } else {
      picked.set(frameOf[i], [rowOf[i]]);
    }
  }
  return [...picked].map(([frameIndex, rows]) => pickRows(frames[frameIndex], rows));
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

// Why an edge query without rows is a problem, or null when it is not one. A query that ran and returned
// no rows is the healthy state of a query that filters in the data source (`> 0`): it must not look like
// a refId that names no query.
function queryProblem(config: FlowConfig, query: FlowQueryState): { error: string; warning: string } | null {
  if (query === 'missing') {
    return {
      error: `no query "${config.refId}"`,
      warning: `Flow overlay: no query with the refId "${config.refId}" ran (it does not exist or is hidden)`,
    };
  }
  if (query === 'unknown') {
    return {
      error: `no data for query "${config.refId}"`,
      warning: `Flow overlay: query "${config.refId}" returned no data`,
    };
  }
  return null;
}

function flowWarnings(config: FlowConfig, stats: FlowStats, problem: { warning: string } | null): string[] {
  const warnings: string[] = [];
  if (problem) {
    warnings.push(problem.warning);
  }
  if (stats.readRows < stats.totalRows) {
    warnings.push(
      `Flow overlay: query "${config.refId}" returned ${stats.totalRows} rows; the worst ${stats.readRows} are used. Narrow the query (for example with topk)`
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

function emptyModel(config: FlowConfig, problem: { error: string; warning: string }): FlowModel {
  return {
    config,
    depth: 0,
    levelLabel: '',
    groupLevel: false,
    edges: [],
    valuedCount: 0,
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
      excludedWorst: null,
      selfWorst: null,
      invalidOrder: 0,
      edgeCount: 0,
      noValue: 0,
      examples: [],
    },
    warnings: [problem.warning],
    error: problem.error,
  };
}

// Why the endpoint mappings cannot be used, or nothing when they can. A mapping that is half filled in
// or names no hierarchy label is not skipped: the mappings together say which level an endpoint resolves
// to, so drawing with the rest would show the edges at a level the user did not ask for.
function configProblem(config: FlowConfig, levels: LevelDef[]): { error: string; warning: string } | null {
  if (config.incompleteEndpoints > 0) {
    return {
      error: 'endpoint mapping incomplete',
      warning: 'Flow overlay: every endpoint mapping needs a hierarchy label, a source label and a destination label',
    };
  }
  if (config.endpoints.length === 0) {
    return {
      error: 'no endpoint mapping',
      warning: 'Flow overlay: map at least one hierarchy label to a source and a destination label of the edge query',
    };
  }
  const levelLabels = new Set(levels.map((level) => level.label));
  const unknown = config.endpoints.filter((m) => !levelLabels.has(m.level)).map((m) => `"${m.level}"`);
  if (unknown.length === 0) {
    return null;
  }
  const names = [...new Set(unknown)].join(', ');
  return {
    error: `endpoint mapping ${names} is not a hierarchy label`,
    warning: `Flow overlay: endpoint mapping ${names} is not a hierarchy label`,
  };
}

/**
 * The automatic color range of the arcs, used for an endpoint that the field config leaves open. It is
 * built so that a filter cannot repaint a degraded edge in the color of the healthy end:
 * - from every edge with a value, before the filter (the filter decides what is drawn, not what a color
 *   means);
 * - including the threshold, the boundary between drawn and not drawn;
 * - including 0 when higher is worse and every value is above it, so that an edge query that returns
 *   only its degraded pairs (`> 0` in the query) does not put the least degraded one at the healthy end.
 */
export function flowColorRange(edges: FlowEdge[], config: FlowConfig): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const edge of edges) {
    if (edge.value !== null) {
      min = Math.min(min, edge.value);
      max = Math.max(max, edge.value);
    }
  }
  if (!Number.isFinite(min)) {
    return { min: 0, max: 1 };
  }
  if (config.threshold !== undefined) {
    min = Math.min(min, config.threshold);
    max = Math.max(max, config.threshold);
  }
  return { min: config.worst === 'high' ? Math.min(min, 0) : min, max };
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
  timeZone: string,
  query: FlowQueryState = frames.length > 0 ? 'found' : 'unknown'
): FlowModel {
  const levels = options.levels;
  const invalid = configProblem(config, levels);
  if (invalid) {
    return emptyModel(config, invalid);
  }
  const reduceCalc = options.reduceCalc || 'lastNotNull';
  const names = flowLabelNames(config);
  const labelFrames = flowLabelColumns(frames, names);
  const totalRows = countFrameRows(labelFrames);
  const readFrames =
    totalRows > MAX_FLOW_ROWS
      ? selectWorstRows(labelFrames, reduceCalc, config.worst, totalRows, MAX_FLOW_ROWS)
      : labelFrames;
  const rows = normalizeFrames(flowLabelText(readFrames, names), reduceCalc);
  const index = buildEndpointIndex(root, levels, config.endpoints);
  const collected = collectFlowEdges(rows, index, config);
  const stats: FlowStats = { ...collected.stats, totalRows };
  const problem = totalRows === 0 ? queryProblem(config, query) : null;
  const edges = selectFlowEdges(collected.edges, config.worst, config.threshold);
  // Passing a range and a single frame also keeps buildMetricInfos from scanning every value of an
  // oversized result.
  const valueFrame = labelFrames.find((frame) => frame.fields.some((field) => field.type === FieldType.number));
  const range = flowColorRange(collected.edges, config);
  const metricInfo = valueFrame
    ? buildMetricInfos([valueFrame], theme, timeZone, new Map([[valueFrame.refId ?? 'A', range]]))[0]
    : undefined;
  return {
    config,
    depth: index.depth,
    levelLabel: levels[index.depth - 1]?.label ?? '',
    groupLevel: index.depth < levels.length,
    edges,
    valuedCount: edges.filter((edge) => edge.value !== null).length,
    nodes: collected.nodes,
    ...buildFlowIndex(edges),
    stats,
    warnings: flowWarnings(config, stats, problem),
    error: problem?.error ?? null,
    metricInfo,
  };
}

/** Key of the node that a cell's flows are attached to: the cell itself, or its group at the endpoint level. */
export function flowNodeKey(model: FlowModel, cell: CellModel): string {
  return pathKey(cell.path.slice(0, model.depth));
}

/**
 * How a bound on the number of arcs is shared between the edges with a value and the edges without one,
 * when both do not fit. An edge without a value cannot be ranked: its probe may have failed because the
 * path is the most broken one, so it must not be the first to go. It must not crowd out the edges that
 * are known to be degraded either. So the edges without a value get what the valued ones leave free, and
 * at least half of the bound.
 */
export function shareFlowBound(valued: number, unknown: number, bound: number): { valued: number; unknown: number } {
  if (valued + unknown <= bound) {
    return { valued, unknown };
  }
  const unknownShare = Math.min(unknown, Math.max(Math.floor(bound / 2), bound - valued));
  return { valued: bound - unknownShare, unknown: unknownShare };
}

/** How many edges with and without a value are drawn while nothing is focused; none in hover mode. */
export function flowRestShare(model: FlowModel): { valued: number; unknown: number } {
  if (model.config.show === 'hover') {
    return { valued: 0, unknown: 0 };
  }
  return shareFlowBound(model.valuedCount, model.edges.length - model.valuedCount, model.config.restArcs);
}

/** The arcs drawn while nothing is focused, worst first, then those without a value; none in hover mode. */
export function flowBaseEdges(model: FlowModel): FlowEdge[] {
  const share = flowRestShare(model);
  return [
    ...model.edges.slice(0, share.valued),
    ...model.edges.slice(model.valuedCount, model.valuedCount + share.unknown),
  ];
}

// The first index of an ascending list of edge indexes that points at an edge without a value.
function firstUnknown(indexes: number[], valuedCount: number): number {
  let low = 0;
  let high = indexes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (indexes[mid] < valuedCount) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// At most `bound` of a node's edge indexes (ascending: worst first, then those without a value), shared
// like the resting arcs. Reads only what it returns.
function boundedIndexes(model: FlowModel, indexes: number[], bound: number): number[] {
  if (indexes.length <= bound) {
    return indexes;
  }
  const split = firstUnknown(indexes, model.valuedCount);
  const share = shareFlowBound(split, indexes.length - split, bound);
  return [...indexes.slice(0, share.valued), ...indexes.slice(split, split + share.unknown)];
}

/**
 * The edges to emphasise for a set of node keys (today the hovered cell's node; a selection can pass
 * several): every edge that touches one of the nodes, then the other edges of the paths those edges are
 * on, so that pointing at one member of a ring shows the whole ring. Returns null when the nodes have no
 * edge, so that an unrelated cell does not dim the overlay. At most MAX_FLOW_ARCS edges, worst first and
 * shared with the edges without a value like the resting arcs; the cost depends on the edges returned,
 * not on the number of edges in the model.
 */
export function flowFocusEdges(model: FlowModel, nodeKeys: string[]): FlowEdge[] | null {
  const picked = new Set<number>();
  for (const key of nodeKeys) {
    for (const index of boundedIndexes(model, model.byNode.get(key) ?? [], MAX_FLOW_ARCS - picked.size)) {
      picked.add(index);
    }
  }
  if (picked.size === 0) {
    return null;
  }
  const paths = new Set<string>();
  for (const index of picked) {
    model.edges[index].hops.forEach((hop) => paths.add(hop.path));
  }
  for (const path of paths) {
    for (const index of model.byPath.get(path) ?? []) {
      if (picked.size >= MAX_FLOW_ARCS) {
        break;
      }
      picked.add(index);
    }
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
