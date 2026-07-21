# ClusterView Panel — Design

Status: implemented (branch `design-spec`).
This document describes the design of the ClusterView Grafana panel plugin and, for each significant choice, records why it was selected over the alternatives that were considered. It replaces the Japanese working documents (design spec and implementation plan) that guided the initial build; where the implementation deliberately diverged from the original plan during review, this document describes the final, confirmed behavior.

## 1. Background and goals

ClusterView is a hierarchical cell-grid panel for monitoring large AI/HPC clusters (typically GPU nodes) with Prometheus or VictoriaMetrics as the data source. It replaces the HewlettPackard `hpe-grafana-clusterview-panel`, which the team used in production and whose limitations motivated this plugin. Six concrete problems drove the design:

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
  → cells       src/data/values.ts      leaves ← CellModel {values by refId, labelSets}
  → display     src/data/display.ts     per-refId Grafana display processors (color/unit)
  → layout      src/layout/layout.ts    tree + panel size → cell rectangles
  → render      src/render/renderer.ts  single <canvas>, dpr-aware, sticky labels
```

Interactive elements — hover tooltip, drilldown popover, metric selector, split legend, link menu — are React DOM overlays positioned in the scroll container's content coordinate space.

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

## 6. Color, units, and scales — delegation to Grafana

**Decision: delegate color, unit, decimals, thresholds, min/max, and data links entirely to Grafana's standard field configuration; implement no custom color DSL.**
*Alternatives:* (a) reimplement a Conditions-style expression system (HPE), (b) a custom gradient editor, (c) standard field config.
*Rationale:* option (c) directly solves problems 1 and 4 with zero new UI: the standard Field tab provides continuous gradient schemes, threshold steps, unit formatting, and per-query overrides, all familiar to Grafana users and maintained upstream. This requires `useFieldConfig()` in `module.ts` — without it the Field tab does not exist and the whole approach collapses (caught in plan review).

**Per-query scales.** Queries measure different quantities (watts vs. degrees), so a shared min/max would flatten one metric's gradient. For each refId, effective min/max default to the min/max of the **displayed** cell values (after time reduction and spatial aggregation), unless the user set explicit min/max in field config (each endpoint independently respected).

**Decision: write the effective range to both `field.config.min/max` and `field.state.range`.**
*Rationale:* `getDisplayProcessor` prefers `state.range` when present, and Grafana's `applyFieldOverrides` can inject a *panel-global* range into `state.range` — which would silently override per-refId scales. Setting both, with `state.range` recomputed from the effective values, makes the per-query scale win deterministically (plan-review finding).

Ranges derive from displayed values rather than raw history so that a transient historical outlier or pre-aggregation sample cannot distort today's color scale.

## 7. Layout

The layout engine recursively measures the tree under a candidate cell size and picks the largest size that fits the panel:

- Constants: `S_MAX = 40`, `S_MIN = 6` (px), cell gap 1, group gap 4, label height 16, border padding 2.
- Search: **descending scan** from `S_MAX` to `S_MIN` in 0.5 px steps (≤ 69 candidates).
- If even `S_MIN` does not fit vertically, cells stay at 6 px and the panel scrolls vertically with the top-level group labels rendered sticky; horizontal overflow scrolls horizontally.

**Decision: descending linear scan, not binary search.**
*Rationale:* binary search was the original plan and was rejected in review with a counterexample: nested `flow` layouts wrap, so `fits(size)` is **not monotonic** — a larger cell can change wrapping and produce a *smaller* total height. Binary search over a non-monotonic predicate returns wrong answers; 69 cheap measurements per layout pass are negligible, and the scan is trivially correct.

Cell value text is drawn only when it fits: font size `clamp(cellHeight × 0.38, 9, 15)` px and text width + 4 px ≤ cell width, preferring the unit-formatted string, then the bare number, then nothing. Text color uses `theme.colors.getContrastText` against the cell color.

## 8. Multi-metric display

**Decision: default is single-metric with a panel-header selector; split-cell rendering is an explicit opt-in (`displayMode: 'split'`), capped at 9 regions.**
*Alternatives:* (a) split cells by default (the initial recommendation), (b) single with selector, split opt-in, (c) tabs/paging.
*Rationale:* the user raised the concern that always-split cells would degrade day-to-day dashboard reading (small regions, unfamiliar look) — the common case is monitoring one metric with occasional comparison. So (b): the default stays visually identical to a classic single-metric grid, a radio selector appears in the header when more than one query exists, and split mode is a deliberate choice. Split layouts follow fixed rules (2–3 columns, 2×2, 3×2, 3×3) shared by renderer, legend, and click resolution through a single `splitRects` function, with a legend that includes a position minimap per metric.

**Decision: two distinct display sets — the selector is based on `refIds`, split mode on `metricInfos`.**
*Rationale:* a query that returned zero series still deserves visibility in single mode: its refId is selectable and the grid renders entirely in the missing color, which reads as "this query returned nothing" instead of the query silently disappearing. Split mode, however, allocates scarce cell area; regions are allocated only to queries that actually returned data (`metricInfos`), ordered by the dashboard's target (refId) order regardless of frame arrival order. Renderer, legend, and click-region resolution all consume the same ordered set, so what you see, what the legend says, and what a click resolves to cannot diverge (unified after a review finding).

`displayMode` is normalized as `options.displayMode ?? 'single'` at runtime so dashboards saved before the option existed behave correctly.

## 9. Interactions

### Hover tooltip

Hit testing maps content coordinates (including `scrollLeft`/`scrollTop`) to a cell by linear scan over the laid-out rectangles; the tooltip shows the hierarchy path and every metric's formatted value (`formattedValueToString`), listing zero-series refIds with a missing indication.

**Decision: use Grafana theme tokens for the tooltip surface, text, border, and shadow.**
*Rationale:* the tooltip is a panel overlay, so fixed dark colors would become unreadable or visually inconsistent in light themes. Standard theme tokens keep it aligned with the rest of the panel without changing its content or interaction behavior.

**Decision: linear-scan hit test, no spatial index.**
*Rationale:* at thousands of cells a linear scan costs microseconds per mouse event; an R-tree or grid index would be premature complexity. This was proposed in external review and consciously declined.

### Click: data links first, drilldown popover otherwise

**Decision: configured Data Links take priority over the built-in popover; the contract is the presence of `field.getLinks`.**
*Rationale:* if the user configured navigation, the click should navigate — the built-in preview must never shadow explicit configuration. `getLinks` presence (not `config.links.length`) is the correct API-level signal (the plan's original test contradicted its own implementation here; the contract was settled in review). Reduced values pass `calculatedValue`; table rows resolve the matching row (requiring all label columns to be present) and pass `valueRowIndex`; `LinkModel.onClick` is preserved so internal links work. With multiple links a small theme-aware selection menu opens, clamped to the visible area with a max height and internal scrolling. Duplicate links produced per-series by the same configuration are deduplicated only when semantically identical (same href/title/target and, for callback links, the same function reference — different callbacks are conservatively kept). The original spec wording "Grafana standard context menu" was amended: the menu is panel-rendered because Grafana does not expose its context menu for this use.

Without links, a click opens the **drilldown popover**: per-metric sparklines built from the time-series data already at hand, the current value, and the series count. When one cell aggregates several series and their timestamps align, the sparkline aggregates **per timestamp with the same spatial aggregation as the cell value** (missing samples excluded; all-missing timestamps become `null`), so the sparkline is the time-resolved version of the number the user clicked. If timestamps do not align, the popover falls back to the first series and says so explicitly instead of mislabeling it as an aggregate. The popover flips and clamps within the visible scroll area and closes on Esc, outside pointer-down, or scroll.

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

Custom options are intentionally few; everything color/unit/link-related lives in standard field config:

| Option | Values (default) |
|---|---|
| `levels` | ordered `LevelDef[]` (one raw level) — custom editor with live preview |
| `displayMode` | `single` (default) / `split` |
| `showValues` | boolean (on) |
| `missingColor` | color (theme fallback) |
| `spatialAggregation` | `max` (default) / `mean` / `min` / `sum` |
| `reduceCalc` | numeric reducers only: `lastNotNull` (default), `last`, `mean`, `min`, `max`, `sum`, `count` |

**Decision: restrict `reduceCalc` to an allowlist of numeric reducers rather than the full standard Calculation picker.**
*Rationale:* non-numeric reducers (`allValues`, `uniqueValues`, …) produce values the color pipeline cannot render; offering them would be an invitation to a broken panel. A guarded Select with a numeric allowlist keeps the standard vocabulary while making invalid states unrepresentable.

## 11. Plugin metadata and toolchain

- id `yuuk1-clusterview-panel`, name `ClusterView`, `grafanaDependency: ">=11.6.0"`.
- Scaffold: `@grafana/create-plugin@7.0.5` (pinned). **Rationale:** reproducibility of regeneration, and 7.0.5 builds against `@grafana/* ^12.x` — closer to the supported minimum (11.6) than newer scaffolds targeting 13.x, reducing the risk of accidentally depending on 13-only APIs.
- The pinned scaffold conflicts with the floating `@grafana/tsconfig@2.2.0` (`moduleResolution: "bundler"` vs. the scaffold's ts-node `module: "commonjs"` → TS5095). Fixed by overriding `moduleResolution: "nodenext"` in the ts-node block of the **root** `tsconfig.json` (mirroring upstream create-plugin 7.x), because `.config/` is tool-managed and must not be edited.
- `jest-canvas-mock` is imported from the root `jest-setup.js` **after** `.config/jest-setup` — the scaffold's setup (run in `setupFilesAfterEnv`) overwrites `getContext`, so the plan's original `setupFiles` placement produced a silently non-functional mock. Load order is the constraint; a comment in the file records it.

## 12. Testing strategy

- **Unit (Jest + jest-canvas-mock):** every pipeline stage TDD-tested as a pure function; renderer tested through the canvas mock (split regions, missing-color path, contrast text).
- **Component (React Testing Library):** option editors (add/remove/reorder levels, preset switching, live preview, reducer allowlist), panel wiring (selector, tooltip coordinates incl. scroll, data-link priority, link menu, popover close paths, requery race with deferred promises).
- **E2E (`@grafana/plugin-e2e` + Playwright):** a provisioned TestData dashboard (`uid: clusterview-e2e`, generic zone/host/gpu data with unpadded host numbers so natural order differs from lexicographic order) exercised against the default Grafana image **and** `GRAFANA_VERSION=11.6.0`. Canvas assertions use polling plus color quantization/dominant-color counts rather than screenshot equality, to tolerate cross-version anti-aliasing differences.
- Checks that genuinely require human eyes or a live Prometheus (visual sparkline quality, in-cell unit suffix at various widths, instant requery against a real datasource, split-region visuals, minimum-cell-size boundary) are explicitly listed as manual follow-ups rather than silently claimed.

## 13. Out of scope

Deliberately not implemented (YAGNI, confirmed during design): Conditions-style expression DSL, modifier-click actions, pinned/frozen cells, zoom/pan of the grid, custom URL template mechanisms outside standard Data Links, and datasource-specific code paths (the pipeline is frame-shape-based and datasource-agnostic; Prometheus/VictoriaMetrics are the design targets, not a hard dependency).

## 14. Known limitations / future work

- The link menu has a fixed 240 px width; panels narrower than that would clip it.
- Verification against a live Prometheus/VictoriaMetrics (including instant→range requery behavior) is still outstanding; README states this.
- Overlay positions are computed at click time and are not recomputed if the panel is resized while an overlay is open (scrolling closes overlays, which covers the common case).
