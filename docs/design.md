# FleetGrid Panel — Design

Status: implemented (branch `design-spec`).
This document describes the design of the FleetGrid Grafana panel plugin and, for each significant choice, records why it was selected over the alternatives that were considered. It replaces the Japanese working documents (design spec and implementation plan) that guided the initial build; where the implementation deliberately diverged from the original plan during review, this document describes the final, confirmed behavior.

## 1. Background and goals

FleetGrid is a hierarchical cell-grid panel for monitoring large AI/HPC clusters (typically GPU nodes) with Prometheus or VictoriaMetrics as the data source. It replaces the HewlettPackard `hpe-grafana-clusterview-panel`, which the team used in production and whose limitations motivated this plugin. Six concrete problems drove the design:

1. **Manual color conditions** — the HPE panel colors cells only through hand-written per-threshold "Conditions" expressions; there is no value-gradient coloring.
2. **Poor number legibility** — numeric values inside small cells are hard to read or absent.
3. **No automatic ordering** — numeric label fragments (`001`, `002`, …) are not naturally sorted without manual configuration.
4. **No unit formatting** — values cannot be shown as `Gbps`, `W`, `°C`, etc.
5. **No instant drilldown** — inspecting a cell's time series requires navigating away via a configured link; there is no in-place preview.
6. **No multi-metric comparison** — one panel shows one metric; comparing power vs. temperature requires duplicated panels.

Constraints: Grafana >= 11.6.0, TypeScript/React/Emotion, `@grafana/create-plugin` conventions, and a hard rule that fixtures, code, and commits never contain real-system-specific names (generic names such as `zone-a`, `node-a001` are used throughout).

## 2. Architecture overview

The panel is a pipeline of pure functions feeding a single-canvas renderer, with React DOM used only for interactive overlays:

```
DataFrame[]                         (Grafana query result)
  → normalize   src/data/normalize.ts   frames → NormalizedRow[] {labels, value, refId}
  → hierarchy   src/data/hierarchy.ts   rows + LevelDef[] → tree (natural sort, warnings)
  → cells       src/data/values.ts      leaves ← CellModel {values + source labels by refId}
  → display     src/data/display.ts     standard per-refId Grafana display processors
  → ranges      src/data/model.ts       cell/refId range resolution + processor cache
  → layout      src/layout/layout.ts    tree + panel size → cell rectangles
  → render      src/render/renderer.ts  single <canvas>, dpr-aware, sticky labels
```

Interactive elements — hover tooltip, drilldown popover, metric selector, split legend, link menu — are React DOM overlays positioned in the scroll container's content coordinate space.

The optional flow overlay (§15) is a second, separate pipeline: one query is taken out of the pipeline above and drawn as arcs on canvases of its own, stacked on the cell canvas. The cell pipeline does not know about it.

**Decision: single canvas + DOM overlay, not per-cell DOM.**
*Alternatives:* one DOM node per cell (the HPE approach), SVG, canvas.
*Rationale:* target scale is roughly 2,400–15,000 cells. Per-cell DOM nodes at that scale dominate layout/paint cost and GC pressure; SVG has the same node-count problem. A single canvas draws the entire grid in one pass, while the handful of genuinely interactive elements stay in DOM where accessibility and event handling are natural. The panel deliberately avoids claiming benchmark numbers; the design goal is to remove per-cell DOM overhead, not to promise a frame rate.

**Decision: pure-function pipeline stages.**
*Rationale:* every stage up to rendering is a pure function of its inputs, so each stage is unit-testable without a browser, and review could verify contracts (e.g. "missing values are `null` after the union") stage by stage. This paid off repeatedly during review, where cross-stage bugs were localized quickly.

## 3. Data contract

Two input shapes are supported, matching what Prometheus/VictoriaMetrics produce through Grafana:

- **Time-series frames** — labels on `field.labels`; the time-direction reduction (a user-selectable numeric reducer, default `lastNotNull`) collapses each series to one value.
- **Table frames** — Prometheus "instant + format: table"; string columns are labels, the first numeric column is the value, one row per series.

**Decision: detect table frames as "has string columns AND no labeled numeric fields", not "has no Time field".**
*Rationale:* Prometheus instant+table output *includes* a Time column, so the naive `!timeField` check misclassifies it. The chosen predicate keys on what actually distinguishes the shapes: table frames carry labels as string columns, time-series frames carry them on numeric fields.

Non-finite numeric values (`NaN`, `±Infinity`) are normalized to `null` so they cannot leak into aggregation or range computation. Missing values remain `null` end-to-end and render in the configurable missing color.

## 4. Hierarchy definition

Users define an ordered list of levels; each level names a label and how to extract the grouping key from it:

- `raw` — use the label value as-is.
- `trailingNumber` — extract the trailing digits (`/(\d+)$/`), e.g. `node-a017` → `017`.
- `regex` — a user regex whose **first capture group** is the key; no capture or no match excludes the row.

Sorting per level is `natural` (default), `naturalDesc`, or `none`, implemented with `localeCompare(..., {numeric: true})`. Each level also selects its layout (`vertical` / `horizontal` / `flow` / `grid` with a column count), border, and label visibility. The options editor shows a live preview (distinct key count and first values) computed with the same extraction and sort code the pipeline uses.

**Decision: label + extraction presets with live preview, instead of the HPE fixed 8-level regex configuration.**
*Alternatives:* (a) keep the HPE model (a fixed number of levels, each a regex, no feedback), (b) a single "group by" expression language, (c) presets + optional regex with live preview.
*Rationale:* option (c) was chosen and approved because the two dominant real-world cases (use a label verbatim; strip a numeric suffix) become zero-regex configurations, the escape hatch (regex) remains for irregular naming, and the live preview turns misconfiguration into immediate visible feedback instead of a silently empty panel. An expression language was rejected as YAGNI and a new DSL to maintain.

**Silent-empty avoidance.** Rows that fail extraction are excluded but always produce a warning (`N/M rows did not match the hierarchy and were excluded` plus the detected label keys), including the case where *no* row completes a full path. Label-presence statistics are collected for every level of every row independently of whether the row was accepted, so the warning never claims a label is absent when it exists (an early-`break` bug in the original plan's code, found and fixed in review). If frames exist but normalization yields zero rows, the panel shows an explicit data error rather than an empty canvas.

## 5. Cells, union, and spatial aggregation

Each tree leaf gets a `CellModel` whose `values` map contains **every** query refId (union semantics): a refId with no series for that cell holds `null`. When several series land in the same cell (e.g. per-CPU series under a node-level hierarchy), they are combined by the user-selected **spatial aggregation** (`max` default, `mean`, `min`, `sum`).

**Decision: cells retain all raw label sets (`labelSets`), not just the first matching row's labels.**
*Rationale:* when extraction collapses different raw values into one key (e.g. `node-a017` and `node-b017` both → `017`), the cell value aggregates both series. Drilldown and data-link resolution must therefore search **all** contributing label sets, or the sparkline/link would silently describe a subset of what the number shows. This replaced the original "first row's labels" design after the final review demonstrated the mismatch.

When at least one valid range rule compiles, cells additionally retain complete, non-null contributing labels per refId (`sourceLabelSetsByRef`). Table frames take these from all string columns in the row; time-series frames take them from the numeric field's labels. Keeping provenance per refId prevents one metric's labels from selecting another metric's range; an absent, empty, or entirely invalid rule list stays on the legacy path without this extra provenance.

**Decision: an aggregated cell receives an override only when every contributing label set selects the same rule identity.**
*Rationale:* two ordered rules can produce the same numeric endpoints today but diverge after a dashboard edit. Treating rule identity — including matched versus unmatched — as the contract makes conflict detection stable and independent of query row order. A conflict falls back to the standard range and produces one warning per refId with a count and up to three example paths, rather than an unbounded warning per cell.

## 6. Color, units, and scales — delegation to Grafana

**Decision: keep unit, decimals, value mappings, color scheme, thresholds, and data links in Grafana's standard field configuration; add only label-based Min/Max selection to FleetGrid.**
*Alternatives:* (a) reimplement a Conditions-style expression system, (b) add a threshold/color DSL, (c) layer ordered range matchers over standard field config.
*Rationale:* Grafana field overrides have no matcher for a table row's labels, so per-refId Min/Max cannot express zone/pod limits inside one query. Option (c) fills only that gap while preserving Grafana's familiar formatting, mappings, color processors, thresholds, and Data Links. `useFieldConfig()` remains required; range overrides alter the field clone passed to `getDisplayProcessor`, not the rest of the display contract.

**Per-query scales.** Queries measure different quantities (watts vs. degrees), so a shared min/max would flatten one metric's gradient. For each refId, effective min/max default to the min/max of the **displayed** cell values (after time reduction and spatial aggregation), unless the user set explicit min/max in field config (each endpoint independently respected).

**Label-based scales.** `rangeOverrides` is an ordered list. A rule's refId is optional (blank means all metrics), its one-or-more exact/JavaScript-regex label matchers are ANDed, and the first matching rule wins. At least one endpoint is required. A missing endpoint falls back to the finite field-config endpoint and then to the refId's existing displayed-cell automatic endpoint. The editor reports invalid rules inline, and runtime compilation skips them defensively. An absent or empty list takes the old per-refId path, preserving previous behavior.

**Decision: write every effective range to both `field.config.min/max` and `field.state.range`, and cache its display processor by `refId + min + max`.**
*Rationale:* `getDisplayProcessor` prefers `state.range` when present, and Grafana's `applyFieldOverrides` can inject a panel-global range into `state.range`. Keeping both synchronized makes the selected range deterministic. The cache ensures the render loop does not construct a processor per cell: cells sharing the same refId and numeric range share one processor, while unit, decimals, mappings, color scheme, thresholds, and links continue to come from the original field config.

Ranges derive from displayed values rather than raw history so that a transient historical outlier or pre-aggregation sample cannot distort today's color scale.

**Decision: keep an unambiguous range summary visible in the panel header.** If a displayed metric actually uses one range, the existing formatted endpoints and gradient remain, including for an override-derived range. If it uses two or more range signatures, single and split legends show `Label-based ranges` and the count instead of presenting one gradient as universal. A signature includes numeric endpoints and their fixed/automatic state. Endpoint labels use Grafana's Unit and Decimals formatting, and the missing color is excluded because it represents absent data rather than a point on the scale.

The range state distinguishes all four combinations of endpoints fixed by standard field config or the matched override: `Fixed` when both are explicit, `Auto` when neither is explicit, `Min fixed` when only Min is explicit, and `Max fixed` when only Max is explicit. The effective endpoint values remain visible in every state.

## 7. Layout

The layout engine recursively measures the tree under a candidate cell size and picks the largest size that fits the panel:

- Constants: `S_MAX = 40`, `S_MIN = 6` (px), cell gap 1, group gap 4, label height 16, border padding 2.
- Search: **descending scan** from `S_MAX` to `S_MIN` in 0.5 px steps (≤ 69 candidates).
- If even `S_MIN` does not fit vertically, cells stay at 6 px and the panel scrolls vertically with the top-level group labels rendered sticky; horizontal overflow scrolls horizontally.

**Decision: descending linear scan, not binary search.**
*Rationale:* binary search was the original plan and was rejected in review with a counterexample: nested `flow` layouts wrap, so `fits(size)` is **not monotonic** — a larger cell can change wrapping and produce a *smaller* total height. Binary search over a non-monotonic predicate returns wrong answers; 69 cheap measurements per layout pass are negligible, and the scan is trivially correct.

**Decision: Auto Grid fit-content inverts the height contract; classic grid is unchanged.**
*Rationale:* Grafana's Auto Grid can size a panel to its content only when the plugin calls `PanelPlugin.setFitContentSupport()` and, when `props.fitContent` is set, renders in normal flow without using `height`. That prop is absent from `@grafana/data` 12.4 / Grafana 11.6–13.2, so the plugin duck-types the method and the prop and does not raise `grafanaDependency`. Fit-content passes an unbounded height into `computeLayout`, so cell size is constrained by width only (typically `S_MAX`) and `contentHeight` becomes the body's explicit height. Min/max and overflow stay on the Auto Grid cell; the plugin does not grow cells to fill leftover min-height or match-row space. Classic / custom grid keeps the existing "fit the given box" path.

Cell value text is drawn only when it fits: font size `clamp(cellHeight × 0.38, 9, 15)` px and text width + 4 px ≤ cell width, preferring the unit-formatted string, then the bare number, then nothing. Text color uses `theme.colors.getContrastText` against the cell color.

## 8. Multi-metric display

**Decision: default is single-metric with a panel-header selector; split-cell rendering is an explicit opt-in (`displayMode: 'split'`), capped at 9 regions.**
*Alternatives:* (a) split cells by default (the initial recommendation), (b) single with selector, split opt-in, (c) tabs/paging.
*Rationale:* the user raised the concern that always-split cells would degrade day-to-day dashboard reading (small regions, unfamiliar look) — the common case is monitoring one metric with occasional comparison. So (b): the default keeps a classic single-metric grid, a radio selector appears in the header when more than one query exists, and split mode is a deliberate choice. The header remains present for a single query because it also carries the always-visible range legend. Split layouts follow fixed rules (2–3 columns, 2×2, 3×2, 3×3) shared by renderer, legend, and click resolution through a single `splitRects` function. Each split legend entry combines the position minimap with the metric name, formatted range, and range state; entries wrap as needed while the existing 9-region cap remains in force.

**Decision: two distinct display sets — the selector is based on `refIds`, split mode on `metricInfos`.**
*Rationale:* a query that returned zero series still deserves visibility in single mode: its refId is selectable, the grid renders entirely in the missing color, and the header keeps an explicit `No data` legend without fabricating endpoints. Split mode, however, allocates scarce cell area; regions are allocated only to queries that actually returned data (`metricInfos`), ordered by the dashboard's target (refId) order regardless of frame arrival order. Renderer, legend, and click-region resolution all consume the same ordered set, so what you see, what the legend says, and what a click resolves to cannot diverge (unified after a review finding).

`displayMode` is normalized as `options.displayMode ?? 'single'` at runtime so dashboards saved before the option existed behave correctly.

## 9. Interactions

### Hover tooltip

Hit testing maps content coordinates (including `scrollLeft`/`scrollTop`) to a cell by linear scan over the laid-out rectangles; the tooltip shows the hierarchy path and every metric's formatted value (`formattedValueToString`), listing zero-series refIds with a missing indication. For each value it also shows the cell's actual formatted Min/Max, `Fixed` / `Auto` / `Min fixed` / `Max fixed` state, and either the matched conditions, standard-range fallback, or conflict fallback. The drilldown popover and Data Links consume the same cell-specific processor while preserving their hierarchy path, sparkline, and link behavior.

**Decision: use Grafana theme tokens for the tooltip surface, text, border, and shadow.**
*Rationale:* the tooltip is a panel overlay, so fixed dark colors would become unreadable or visually inconsistent in light themes. Standard theme tokens keep it aligned with the rest of the panel without changing its content or interaction behavior.

**Decision: linear-scan hit test, no spatial index.**
*Rationale:* at thousands of cells a linear scan costs microseconds per mouse event; an R-tree or grid index would be premature complexity. This was proposed in external review and consciously declined.

### Click: data links first, drilldown popover otherwise

**Decision: configured Data Links take priority over the built-in popover; the contract is the presence of `field.getLinks`.**
*Rationale:* if the user configured navigation, the click should navigate — the built-in preview must never shadow explicit configuration. `getLinks` presence (not `config.links.length`) is the correct API-level signal (the plan's original test contradicted its own implementation here; the contract was settled in review). Reduced values pass `calculatedValue`; table rows resolve the matching row (requiring all label columns to be present) and pass `valueRowIndex`; `LinkModel.onClick` is preserved so internal links work. With multiple links a small theme-aware selection menu opens, clamped to the visible area with a max height and internal scrolling. Duplicate links produced per-series by the same configuration are deduplicated only when semantically identical (same href/title/target and, for callback links, the same function reference — different callbacks are conservatively kept). The original spec wording "Grafana standard context menu" was amended: the menu is panel-rendered because Grafana does not expose its context menu for this use.

**Decision: prefer a 240 px link-menu width, shrinking to the current visible width when necessary.**
*Rationale:* a fixed menu clips in narrow panels. Placement and the rendered border box share the same width, while tiny widths omit horizontal chrome whose device-pixel rounding could otherwise exceed the visible bounds.

Without links, a click opens the **drilldown popover**: per-metric sparklines built from the time-series data already at hand, the current value, and the series count. When one cell aggregates several series and their timestamps align, the sparkline aggregates **per timestamp with the same spatial aggregation as the cell value** (missing samples excluded; all-missing timestamps become `null`), so the sparkline is the time-resolved version of the number the user clicked. If timestamps do not align, the popover falls back to the first series and says so explicitly instead of mislabeling it as an aggregate. The popover flips and clamps within the visible scroll area and closes on Esc, outside pointer-down, or scroll. Both click overlays retain their content-coordinate origin while open, but use visible bounds measured from the current scroll container: the click path measures immediately, and panel resize commits remeasure after DOM layout so an open overlay is repositioned rather than closed or left outside the viewport.

**Decision: cap the drilldown popover's rendered outer height to the visible panel height and enable internal vertical scrolling only when its content is taller.**
*Rationale:* placement must use the same capped height as the rendered border box so the bottom edge remains in bounds, while normal-height content should not gain an unnecessary scroll container. Padding and borders are included in that outer height.

### Instant queries: on-demand range requery

Instant queries have no history at hand, so the panel re-issues the dashboard's targets as a range query when the popover needs series:

- Requery only when an instant target exists (a range query with a missing series must not trigger it).
- Targets are converted with `instant: false, range: true`, `format: 'table'` → `'time_series'`, `maxDataPoints: 100`, `intervalMs = max(15 s, span/100)`.
- Targets are grouped per datasource (mixed-datasource dashboards work) and `DataSourceApi.query` results are awaited whether they are Promises or Observables.

**Decision: panel-level requery cache, not per-cell.**
*Rationale:* one range response serves every cell (cells differ only in which labels they select from the same frames). A per-cell cache (the original plan) would multiply identical queries and complicate invalidation; the panel-level cache is invalidated whenever the panel's own data (requestId) changes.

**Decision: generation-token guards for the async lifecycle.**
*Rationale:* comparing `requestId`s captured in a closure compares the old value with itself and never detects staleness (a review-caught race). A ref-held generation token is checked in success, failure, and finally paths, so a stale response can neither resurrect an old cache nor leak an old error into the new request's state. A failed requery shows a short failure message in the popover and is not retried until the panel data changes (no retry loops).

## 10. Options surface

Custom options are intentionally few; display formatting/color/link behavior lives in standard field config, with one targeted range-matching option:

| Option | Values (default) |
|---|---|
| `levels` | ordered `LevelDef[]` (one raw level) — custom editor with live preview |
| `displayMode` | `single` (default) / `split` |
| `showValues` | boolean (on) |
| `missingColor` | color (theme fallback) |
| `spatialAggregation` | `max` (default) / `mean` / `min` / `sum` |
| `reduceCalc` | numeric reducers only: `lastNotNull` (default), `last`, `mean`, `min`, `max`, `sum`, `count` |
| `rangeOverrides` | ordered `RangeOverride[]` (`[]`) — optional refId, one-or-more exact/regex label matchers, optional Min/Max |

The **Color scale overrides** editor supports add/remove/reorder and multiple matchers per rule. It derives refId, label-name, and sample-value suggestions from both table and time-series query results while allowing custom values. Inline validation covers missing matchers or labels, invalid regex, non-finite endpoints, neither endpoint set, and `min >= max`; min-only and max-only rules are valid.

**Decision: restrict `reduceCalc` to an allowlist of numeric reducers rather than the full standard Calculation picker.**
*Rationale:* non-numeric reducers (`allValues`, `uniqueValues`, …) produce values the color pipeline cannot render; offering them would be an invitation to a broken panel. A guarded Select with a numeric allowlist keeps the standard vocabulary while making invalid states unrepresentable.

The flow overlay's options are additions with their own table in §15. Its only switch is `flowRefId`: empty (the default) leaves the panel exactly as it was.

## 11. Plugin metadata and toolchain

- id `yuuk1-fleetgrid-panel`, name `FleetGrid`, `grafanaDependency: ">=11.6.0"`.
- Scaffold: `@grafana/create-plugin@7.0.5` (pinned). **Rationale:** reproducibility of regeneration, and 7.0.5 builds against `@grafana/* ^12.x` — closer to the supported minimum (11.6) than newer scaffolds targeting 13.x, reducing the risk of accidentally depending on 13-only APIs.
- The pinned scaffold conflicts with the floating `@grafana/tsconfig@2.2.0` (`moduleResolution: "bundler"` vs. the scaffold's ts-node `module: "commonjs"` → TS5095). Fixed by overriding `moduleResolution: "nodenext"` in the ts-node block of the **root** `tsconfig.json` (mirroring upstream create-plugin 7.x), because `.config/` is tool-managed and must not be edited.
- `jest-canvas-mock` is imported from the root `jest-setup.js` **after** `.config/jest-setup` — the scaffold's setup (run in `setupFilesAfterEnv`) overwrites `getContext`, so the plan's original `setupFiles` placement produced a silently non-functional mock. Load order is the constraint; a comment in the file records it.

## 12. Testing strategy

- **Unit (Jest + jest-canvas-mock):** every pipeline stage TDD-tested as a pure function; range resolution covers refId, exact/regex, AND, order, partial endpoints, table/time-series provenance, conflict fallback, and processor reuse; renderer covers cell-specific colors as well as split regions, missing color, and contrast text.
- **Component (React Testing Library):** option editors (including range-rule add/remove/reorder, suggestions, and validation), panel wiring (multi-range legends, actual-range tooltip, selector, scroll coordinates, data-link priority, link menu, popover close paths, requery race with deferred promises).
- **E2E (`@grafana/plugin-e2e` + Playwright):** a provisioned TestData dashboard (`uid: fleetgrid-e2e`, generic zone/host/gpu data with unpadded host numbers so natural order differs from lexicographic order) exercised against the default Grafana image **and** `GRAFANA_VERSION=11.6.0`. A dedicated two-zone table panel gives equal values different maxima and verifies the legend, each tooltip range, and different canvas fills. Canvas assertions map CSS coordinates to backing-store coordinates and use locally uniform colors rather than screenshot equality, tolerating DPR and cross-version anti-aliasing differences.
- **Flow overlay:** the data stage has example tests and a model-based property test (every edge row lands in exactly one edge or one counted reason; values aggregate like a naive reference; ranking, filter and hover index agree with it), the geometry has example and property tests, and the draw pass is checked through the recorded canvas calls. Component tests cover what a hover paints (the focus layer only) and that a panel without an edge query has no overlay. The E2E dashboard has a `Flow Overlay` panel (a six-hop ring over two zones, a pair in both directions, an edge without a value, one row to a host outside the grid, one self-edge). Whether arcs are legible on a dense grid is a judgement that needs eyes: it was checked on screenshots in the light and dark themes, not by an assertion.
- Checks that genuinely require human eyes or a live Prometheus (visual sparkline quality, in-cell unit suffix at various widths, instant requery against a real datasource, split-region visuals, minimum-cell-size boundary) are explicitly listed as manual follow-ups rather than silently claimed.

## 13. Out of scope

Deliberately not implemented (YAGNI, confirmed during design): Conditions-style expression or threshold DSL (range matchers select only Min/Max), modifier-click actions, pinned/frozen cells, zoom/pan of the grid, custom URL template mechanisms outside standard Data Links, and datasource-specific code paths (the pipeline is frame-shape-based and datasource-agnostic; Prometheus/VictoriaMetrics are the design targets, not a hard dependency). For the flow overlay: animated flow particles and every other continuous animation, a selection mechanism of its own, and paths given as a list of members instead of hops (§15).

## 14. Known limitations / future work

- Verification against a live Prometheus/VictoriaMetrics (including instant→range requery behavior) is still outstanding; README states this.

## 15. Flow overlay

Cells show the state of one endpoint. The flow overlay shows relations between two endpoints — pairwise metrics such as packet loss or round-trip time between hosts, and the hops of a job's communication path — as arcs over the grid. It is optional and off by default.

```
DataFrame[] of the edge query
  → rows        src/data/normalize.ts       the same normalization as for cells, with a row limit
  → edges       src/data/edges.ts           rows → edges between hierarchy nodes, filter, rank, hover index
  → geometry    src/render/flowGeometry.ts  node rectangles from the layout, one arc per edge
  → draw        src/render/flowRenderer.ts  arcs, arrowheads, hop numbers on the overlay canvases
```

`src/components/useFlowOverlay.ts` wires the stages into the panel: `useCellQueries` keeps the edge query out of the cell pipeline, `useFlowModel` builds the model and `useFlowOverlay` paints. `FlowLayers` holds the canvases; `FlowLegend` and `FlowTooltipSection` are the two DOM parts. The panel component itself gains no branches for the overlay.

### Data contract

| Subject | Rule |
|---|---|
| Edge query | The query named by `flowRefId`. Its frames and its target leave the cell pipeline: no cells, no selector entry, no drilldown requery. |
| Row | One directed pair: a source, a destination, a value. Table frames and time-series frames are read as for cells; a range series is reduced with `reduceCalc`. |
| Endpoint | `flowEndpoints` maps a hierarchy label to the edge query's source label and destination label. The endpoint's value is compared with the **raw** value of that hierarchy label on the cells (`CellModel.labelSets`). |
| Level | An endpoint resolves at the deepest mapped hierarchy level: to a cell when that is the leaf level, otherwise to the group. All edges of a panel resolve at the same level. |
| Edge | One per ordered pair of nodes. Its value is the worst of the rows of the pair (`flowWorst`). A→B and B→A are two edges. |
| Value | `number`, or `null` when none of the rows has a finite value. `null` is "unknown": drawn dashed in a neutral color, never 0, and left out by a filter. |
| Not drawn | A row without an endpoint label, with an endpoint that matches no node, or with one that matches several nodes; and a self-edge (both ends resolve to one node). All four are counted. The first three are reported in the warning banner, self-edges in the legend's tooltip. |

**Decision: bind the edge query by an explicit refId and explicit label names, never by recognizing label names.**
*Alternatives:* treat any query that carries `src_*` / `dst_*` labels as an edge query; a per-query custom option in the query editor.
*Rationale:* a saved dashboard must not change when the plugin is updated. A dashboard whose queries happen to carry such labels keeps drawing them as cells until `flowRefId` is set. An explicit refId is also how the panel already addresses a query (`defaultMetric`, range rules). The query editor belongs to the data source, so a panel cannot add options there.

**Decision: match endpoints on raw label values, at the deepest mapped level, and never pick one of several matches.**
*Alternatives:* compare extracted level keys; let the user choose the level separately; take the first match.
*Rationale:* an extracted key such as a trailing number is unique only inside its parent (`node-a1` and `node-b1` both give `1`), while the raw host name is what the edge query reports. The mapped labels already say which level is meant, so a separate level option could only contradict them. Mapping `gpu` alone names a cell under every host; drawing the edge to the first of them would show a relation that does not exist, so such a row is counted as ambiguous instead. Several raw values that the extraction folds into one node (`node-a017`, `node-b017` → `017`) resolve to that node; an edge between them is a self-edge.

**Decision: an edge's value is the worst of its rows, not the cells' spatial aggregation.**
*Alternatives:* reuse `spatialAggregation` (the first implementation); a separate aggregation option for edges.
*Rationale:* several rows per pair are the normal case when the data is finer than the level it is drawn at (RNIC pairs drawn between hosts). With the cells' default `max` and a metric where lower is worse, two healthy RNIC pairs hid a degraded one, in the filter and in the choice of the arcs to draw; with `mean`, one lossy row of eight was diluted below the filter. The overlay already knows which direction is worse, so it takes the worst row: a degraded row can then neither be hidden nor diluted, whatever the cells use. A metric that has to be added up over the rows (a byte rate) is summed in the query, where the grouping is explicit.

**Decision: the label columns of the edge query are read as text.**
*Rationale:* in a table frame a hop number or an ID is often a numeric column. `normalizeFrames` reads labels from string columns only and takes the first numeric column as the value, so a numeric hop column would become the value. Before normalization the columns named by the flow options are converted to strings, and an empty cell becomes "no label" rather than the text `null`.

**Decision: a filter of "strictly worse than a number" with a direction option, not a comparison picker and not Grafana's thresholds.**
*Alternatives:* an operator select (`>`, `>=`, `<`, …); "draw only edges above the base threshold step".
*Rationale:* the panel needs to know which end of the value is the bad one anyway, to choose the edges that win the draw bound and to name the worst peer in the tooltip. One option (`flowWorst`) answers that, and the filter follows from it: `Higher` keeps values above the number (loss > 0), `Lower` keeps values below it (throughput below the objective). Strict comparison makes "loss > 0" work with the natural number 0. Reusing the threshold steps would couple what is drawn to how it is colored, and a metric with only a base step could not be filtered.

### Bounds and cost

Pairwise data grows with the square of the fleet: 1,000 hosts can report a million pairs. Two hard bounds keep the panel's work independent of that:

| Bound | Value | When it binds |
|---|---|---|
| Rows read (`MAX_FLOW_ROWS`) | 20,000 | The first 20,000 rows are read. The banner says how many there were and asks to narrow the query. Which rows come first is the data source's order, so this bound is a guard, not a ranking. |
| Arcs drawn (`MAX_FLOW_ARCS`) | 500 | The worst 500 edges that pass the filter are drawn, and the legend reads `500 of N edges drawn, worst first`. The same bound applies to the arcs of a hovered node. |

Edges are ranked by value in the worse direction, edges without a value last, ties by source and destination key. The ranking is therefore the same for any order of the query result.

| Step | Cost | Runs when |
|---|---|---|
| Find and count the edge query's frames | O(frames × fields); no value is read | data or options change |
| Read rows, resolve endpoints, aggregate | O(R), R ≤ 20,000 rows, hash lookups | data or options change |
| Endpoint index | O(cell label sets × mapped levels) | data or options change |
| Filter and rank | O(E log E), E ≤ R edges | data or options change |
| Hover index (node → edges, path → edges) | O(E + hops) to build | data or options change |
| Node rectangles | O(cells) | layout changes |
| Paint the resting layer | O(min(E, 500)) arcs | data, options, layout or theme change |
| Look up a hovered node | O(its edges + the edges of its paths), at most 500; independent of E | the hovered **node** changes |
| Paint the focus layer | O(focused arcs), at most 500 | the hovered node changes |
| Pointer move inside a cell or a group | nothing | — |

The hover lookup is covered by a test that counts the edges it reads on a 10,000-edge model. A timing test builds the model at the row bound (20,000 distinct edges) against a budget that only a quadratic step would exceed. Measured with Node 22 on the container described below, that build took about 100 ms at best, and looking up and summarizing a node with 270 edges in it took 0.35 ms.

Paint times were measured in headless Chromium without a GPU (software rasterizer) on a shared 4-core container, on a 1531 × 773 px canvas, by drawing and then forcing the canvas to rasterize. They are an upper bound for one environment, not a promise:

| What is painted | Device pixel ratio 1 | Device pixel ratio 2 |
|---|---|---|
| 500 arcs between random points of the canvas | about 30 ms | about 75 ms |
| 500 arcs of at most 300 px | about 11 ms | about 25 ms |
| The focus layer for a host with 38 edges, in the panel | 5 ms median, 11 ms worst | 14 ms median, 49 ms worst |

In the panel, with 1,000 hosts and 25,000 edge rows, the resting layer took about 60–100 ms per paint at ratio 1, including the first color lookups. That is the reason for the bound of 500 and for keeping this layer out of the hover path.

### Drawing

**Decision: two canvases stacked on the cell canvas — the arcs at rest and the arcs in focus — instead of drawing on the cell canvas.**
*Alternatives:* (a) draw the arcs at the end of `renderCanvas`; (b) one overlay canvas that is repainted with the other arcs dimmed on every hover.
*Rationale:* the panel draws when something changes, and hover changes often. With (a) every change of the hovered cell would repaint up to 15,000 cells. With (b) it would repaint up to 500 arcs, which costs tens of milliseconds without a GPU (table above). With two layers a hover paints only the focused arcs, typically a few dozen. The resting layer is dimmed by setting its CSS `opacity`, which the browser composites without painting. Both layers have exactly the cell canvas's size and position, so all three share the content coordinate system and scroll together; pointer events pass through them. This extends the "single canvas" decision of §2 rather than breaking it: the number of DOM nodes is still constant, and the layers exist only while an edge query is named.
*Cost:* memory. Each layer is a backing store of the cell canvas's size. The resting layer holds none while it has no arcs (always, in `On hover` mode); the focus layer allocates one at the first hover and keeps it, because allocating a canvas on every hover costs more than clearing it. So the overlay uses up to two extra canvases.

**Decision: static arcs with an arrowhead, no flow particles.**
*Rationale:* particles need a `requestAnimationFrame` loop that repaints for as long as the panel is mounted. FleetGrid is built to paint only on change, dashboards hold many panels, and a wall display runs for days; an always-running loop per panel is a standing CPU cost for a cue that an arrowhead gives for nothing. Motion also has to be switched off for `prefers-reduced-motion`, so the static encoding has to exist and be sufficient anyway. Animation is therefore left out, not made optional.

**Arc geometry** (`flowArc`): a quadratic Bézier between the centres of the two node rectangles.

- It bulges to the **left of its direction of travel**. A→B and B→A are thus two curves that form a lens, never one line.
- The distance of the control point from the chord grows strictly with the chord's length and levels off (`0.35·L / (1 + L/500)`, at least 8 px). Arcs of different lengths over one row of cells therefore nest like an arc diagram instead of covering each other, and long arcs do not leave the panel.
- When the arc's apex would lie outside the canvas (an arc along the top row), it bulges to the other side, 1.6 times as far, so that it does not coincide with the arc of the opposite direction, which is already there.
- The **arrowhead sits on the middle of the arc**, where a quadratic Bézier runs parallel to its chord. *Alternative:* arrowheads at the destination. *Rationale:* many arcs end on one cell, and their arrowheads would pile up on it and hide it; the middles of the arcs are spread out.
- A group's end point is the centre of the bounding box of its cells. That point alone cannot show that an arc belongs to the group rather than to the cell under it, so the focus layer outlines every cell or group that the focused arcs connect.

**Legibility on a dense, colored grid.** Each arc is stroked twice: first 2 px wider in the panel's background color (a halo), then in its own color. The halo keeps the arc readable on any cell color in the light and dark themes, and separates it from the arcs drawn before it. Arcs are drawn best first, so the worst are on top; arrowheads and hop numbers are drawn after all arcs. The width follows the cell size (1.25–2.5 px) so that arcs do not bury 6 px cells; focused arcs are 1.6 times as wide. The color comes from the edge query's standard field config (`getDisplayProcessor`, the same call as for cells), so thresholds, color schemes and overrides by query work unchanged.

**Decision: the automatic color range is taken before the filter and anchored at the healthy end.**
*Alternative:* the range of the edges that are drawn, as for the cells' displayed values (the first implementation).
*Rationale:* with a continuous scheme and no Min/Max, a range over the drawn edges made the filter repaint them: with losses 0 and 7 and "worse than 1", the only drawn edge was green, with a legend of `7 – 8`; unfiltered, the same edge was red. In the configuration that shows only degraded paths, the degraded paths got the healthy color. The range now spans every valued edge before the filter and includes the threshold. When higher is worse it also includes 0, because an edge query that filters in the data source (`> 0`) returns only degraded pairs, and the least degraded of them would otherwise sit at the healthy end. Lower-is-worse metrics have no such natural healthy end, so there the threshold is the only anchor. Field-config Min/Max still win, and thresholds are absolute anyway. What the overlay cannot do is choose the scheme: `flowWorst` does not invert colors, because it cannot know whether the user already picked a scheme whose low end is the alarm color; the README says so.

**Decision: every arc is its own path.**
*Rationale:* painting all arcs of one color as a single path looked like the cheaper way and was implemented first. Measured in Chromium, one path with 1,000 arcs took 2–3 times as long as 1,000 single strokes at device pixel ratio 1 and was no faster at ratio 2: the strokes of one path overlap everywhere, and the rasterizer has to resolve that. Single strokes also let each halo cut through the arcs below it.

### Hover

Hovering a cell puts the edges of its node in focus: the cell itself, or its group at the endpoint level. The focus also contains the other edges of every path that those edges are on, so pointing at one member of a ring shows the whole ring. The focused arcs are drawn on the focus layer, the resting layer is dimmed, and the tooltip gains the node's outgoing and incoming edge counts, its peer count, its worst peer with the formatted value, and its hops. A node without edges puts nothing in focus and dims nothing. The cell of an open drilldown popover stays in focus while the pointer is elsewhere.

The focus is drawn from the filtered edges, not from the 500 resting arcs, so a hover can show edges that the draw bound left out. The filter is not lifted by a hover: it defines which edges exist for drawing.

**Decision: the focus is a set of node keys.**
*Rationale:* `flowFocusEdges(model, nodeKeys)` takes any number of nodes. Today the panel passes the hovered cell's node. A later multi-cell selection can pass the selected cells' nodes without a change to the data stage or the draw pass; the overlay builds no selection mechanism of its own.

### Ordered paths

A path is given as its hops: each edge row can carry a hop number (`flowOrderLabel`) and a path name (`flowPathLabel`).

| Case | Behavior |
|---|---|
| Ring, open path | Not told apart. A ring is a path whose last hop returns to its first source. |
| Tree | Supported as a set of hops: numbered by depth, or with a path name and no numbers. The panel does not check that hops form a chain, because a tree does not. |
| Several paths | Told apart by the path name. Without `flowPathLabel` all numbered hops are one path. |
| Hop number | A whole number from 0 (at most 9 digits). Any other value keeps the edge, drops the number and is counted in a warning. |
| Gaps | Shown as they are. A missing number means the hop is absent, has an endpoint outside the grid, or is hidden by the filter. |
| Same pair on several paths, or twice on one | One edge and one arc; its value is the worst of all its rows. The arc shows its first hop number (by path name, then by number) followed by `+`. |
| Overlapping numbers | Numbers claim squares of a coarse grid in path and hop order; a number whose squares are taken is not written. |

**Decision: hops, not members.**
*Alternative:* rows that name one member each (`host`, `rank`), from which the panel derives the hops.
*Rationale:* with explicit hops there is nothing to guess: no rule for closing a ring, for a missing rank, or for which member's value belongs to a hop, and a tree needs no separate contract. The price is that the data source has to export pairs; a per-rank metric cannot be turned into pairs in PromQL. Deriving hops from members is a possible later addition with its own contract and is not implemented.

### Options

| Option | Values (default) |
|---|---|
| `flowRefId` | refId of the edge query (`''` — overlay off) |
| `flowEndpoints` | `{ level, source, destination }[]` (`[]`) — custom editor with the hierarchy labels and the edge query's labels as suggestions |
| `flowShow` | `always` (default) / `hover` |
| `flowWorst` | `high` (default) / `low` |
| `flowThreshold` | number (unset — no filter) |
| `flowOrderLabel` | label name (`''`) |
| `flowPathLabel` | label name (`''`) |

Unknown or missing values are normalized at runtime (`resolveFlowConfig`), so a dashboard saved before these options existed, or edited by hand, behaves like the defaults. An edge query without endpoint mappings draws nothing and says so in the banner. So does one with a mapping that is incomplete or that names no hierarchy label: such a mapping is not skipped, because the mappings together decide the level at which the endpoints resolve, and drawing with the remaining ones would show the edges at a level nobody asked for.

### Known limits

- Frames are selected by refId. A transformation that merges or renames the queries removes the edge query.
- All edges resolve at one hierarchy level. Edges between a cell and a group are not supported.
- The overlay has not been verified against a live Prometheus / VictoriaMetrics, and its paint cost has not been measured with a GPU.
