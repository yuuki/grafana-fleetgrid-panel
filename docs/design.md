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

Interactive elements — hover tooltip, drilldown popover, metric selector, split legend, link menu, selection band — are React DOM overlays positioned in the scroll container's content coordinate space. The selection bar is a DOM row under the grid.

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

### Cell selection: Shift gestures, cohort comparison, export

An operator who sees a spatial cluster of anomalous cells selects it, compares it with the rest of the grid, and copies its hosts or filters other panels by them. The code is split the same way as the rest of the panel: pure functions in `src/selection/` (selection state, statistics, formats, variable sync) and `src/render/hitTest.ts` (region and label hit tests), a ring in the canvas renderer, and the gestures and controls in `src/components/` (`useCellSelection`, `SelectionBand`, `SelectionBar`, `CohortDrawer`, `useVariableSync`).

| Gesture (primary button, mouse or pen) | Effect |
|---|---|
| Shift+click a cell | toggles the cell |
| Shift+click a group label | toggles the cells of the group as one unit: removed when all of them are selected, added otherwise |
| Shift+drag | adds every cell the rectangle overlaps |
| Escape during a drag | abandons the drag |
| Escape with the keyboard focus in the panel, or **Clear** | clears the selection |

**Decision: Shift is the only trigger, and it is read at pointer-down.**
*Alternatives:* (a) a "select" mode button in the header, (b) dragging without a modifier, (c) Ctrl/Cmd.
*Rationale:* every existing gesture stays exactly as it was: a press without Shift never reaches the selection code, so click (Data Links, popover), hover and the legend chips need no mode check, and a plain click never changes or clears a selection. A mode button would add a control to every existing panel and a state in which a click means something else. Ctrl/Cmd+click opens links in a new tab in browsers, and Data Links are links. Shift+click on a page extends the text selection, so `mousedown` is cancelled for a Shift press. Reading Shift once makes the gesture independent of when the key is released: a drag that started with Shift selects even if the key comes up first, and the click event that ends any Shift press is swallowed, also after Escape, so an abandoned drag cannot open a popover or follow a link. The pointer is captured for the press, so a drag that leaves the canvas, the panel or the window still ends where the button is released; the band is clamped to the grid's box so it adds no scrollbars.

**Decision: a Shift press on the hover tooltip goes to the grid when the cell under it is the cell that the tooltip shows.**
*Rationale:* the tooltip is placed inside the panel, and in a small panel there is no room beside the pointer, so it is drawn over the pointer. It keeps presses to itself so that its text can be selected and its content scrolled. A Shift+click on a cell then did nothing whenever the tooltip had been drawn first: in a Grafana 12.4.0 panel of 356 × 206 px, four of six Shift+clicks were lost. A press with Shift is never a text selection in the tooltip that matters, so the tooltip lets it through, and the gesture reads the cell from the pointer position. A press without Shift stays with the tooltip as before. In a larger panel the tooltip is placed beside the pointer and covers other cells and group labels. Passing every Shift press through selected a cell or a whole group that the viewer could not see under the tooltip, and wrote it to the synced variable. So the tooltip asks the selection whether a Shift+click at the point would toggle exactly the cell it shows (compared by cell key, because a data update replaces the cell objects while the tooltip stays), and keeps every other press.

**Decision: a rectangle, no freeform lasso.**
*Rationale:* cells are axis-aligned squares in nested grids, so a rectangle that takes every cell it overlaps is predictable to the pixel, and its hit test is exact. A freeform outline needs a rule for cells it cuts through, which a user cannot see while drawing. Arbitrary shapes (half a rack, a checkerboard) are built from rectangles and single-cell toggles, because drags add and Shift+click toggles.

**Decision: a selection is a set of hierarchy paths, each with the label values its cell had when it was selected; a selected path with no cell stays selected.**
*Alternatives:* (a) layout indices or pixel regions, (b) cell objects, (c) dropping selected cells that leave the data, (d) paths only, reading the labels from the current data.
*Rationale:* the path is the cell's identity in the data model (`pathKey`), so a selection means the same cells after a data refresh, a new layout, a resize, a metric switch or a re-sort; indices, pixels and cell objects do not survive a new model. A node that stops reporting disappears from an instant query's result, and it is often exactly the node the operator selected. Dropping it silently would shrink the cohort and the copied host list without notice, so its key is kept, the bar counts it as "not in the current data", it is on neither side of the comparison (it has no value), and it is ringed again when its cell returns.
Reading the labels from the current data (d) was the first implementation, and it made the meaning of a selection depend on the data: when the selected hosts left the data, the copies became empty and the synced variable went back to "All", so the other panels showed every host while the bar still named the selection. A selection now remembers the label sets of each cell at the moment it is selected (`SelectedCell.labelSets`), and copies and the variable are built from those. The bar says how many of the values come only from cells that are not in the current data. A cell that is selected again keeps its first snapshot; label values of a path's hierarchy levels cannot change without the path changing, so the snapshot does not go stale.
Changing the hierarchy levels clears the selection: the paths then name other cells. Like the metric and category selections, it is viewer-local and never saved.

**Decision: the rubber band is one DOM element moved by writing to its style; the selection changes at pointer-up; selected cells get a ring on the same canvas.**
*Rationale:* a pointer move must not render, lay out or repaint. The band is rendered once, hidden, and `useCellSelection` keeps the gesture in a ref, so a move costs one region query and four style writes. The selection is React state and changes once per gesture, which repaints the canvas once, as a legend-chip highlight does. The ring reuses the band geometry of the category highlight ring (device-pixel aligned, capped so the fill survives) in the theme's maximum-contrast colour, drawn inside `drawCell` so group labels and the pinned label stay on top. It is 1 px without a separator on cells below 14 px: selected cells are selected to be compared, so their fill must stay readable. A second canvas for the selection was rejected: it doubles the backing store, and it breaks the single-canvas assumption that the E2E tests and the pinned-label drawing order rely on. The two layers of the flow overlay (§15) do not change this: they exist only while an edge query is named, and the cells, their rings and the labels are still one canvas, which lies under the arcs. A cell that is both selected and category-highlighted shows the selection ring; the highlight still reads from the dimming of the other cells.

**Decision: the region hit test reads a bucket grid; the point hit test stays a linear scan.**
*Rationale:* the band shows the number of cells it covers, so `cellsInRect` runs on every pointer move of a drag and returns up to every cell. It buckets the cells once per layout (cached in a `WeakMap`) by their top-left corner and reads only the buckets a matching cell can start in, so its cost follows the rectangle, not the grid. A bucket is one cell wide and high, and the grid never has more than four buckets per cell (64 for a tiny layout): a sparse or very large layout gets larger buckets instead of more of them, and a layout whose extent is not a finite number falls back to the scan. The property tests compare it with the scan on arbitrary cells and on computed layouts. The earlier decision not to index the point hit test stands: one hover is one scan.

**Decision: the selection bar is a row under the grid, and the layout does not know about it.**
*Alternatives:* (a) in the header, (b) a floating toolbar over the grid.
*Rationale:* in the header the bar wraps onto a second line unless the panel is wide, the grid re-fits to the smaller body, and every cell moves the moment the first one is selected, so the next Shift+click lands on another cell (seen in Grafana during development). A floating toolbar hides cells that the user may want to select. The row takes its height from the scroll container only: `computeLayout` still gets the height without the bar, so no cell moves, and the container scrolls when the bar covers its last rows. With Auto Grid fit-content the panel grows by the bar instead. The cell canvas and the layers of the flow overlay are sized from the same box without the bar (§15), so the three stay one size.

**Decision: Escape clears only with the keyboard focus inside the panel, and uses up the key press.**
*Rationale:* Escape closes many things in Grafana, and a selection is worth more than a popover, so a window-wide listener would lose it by accident. A pointer gesture moves the focus to the selection bar (a `role="group"` that is focusable by script only), so Escape works right after selecting, and Tab continues to its buttons. While a drilldown popover or link menu is open, the selection leaves Escape alone, so that one key press never clears the selection because an overlay was in the way. The key press is stopped at the panel, because Grafana would otherwise also leave the panel view or kiosk mode.

**Limitation, deliberate: cells cannot be selected with the keyboard or by touch.** The grid is one canvas without a focus model: hover and drilldown are pointer-only as well, and arrow keys scroll the container. Cell navigation with a visible cursor over tens of thousands of cells is its own feature. Touch has no Shift, and a touch drag scrolls. What a selection offers afterwards (compare, copy, clear) is plain buttons in the bar and a Grafana `Drawer`.

**Cohort comparison.** For every cell query the drawer compares the selected cells with all other cells of the grid. The edge query of a flow overlay (§15) is not a cell query and has no row. A cell's value is the one the grid shows: reduced over time and aggregated over the series in the cell.

- *Missing values:* a cell without a value for the query is counted under "No value" and is in no statistic. It is not zero. Selected cells that are not in the data are on neither side.
- *Quantiles:* median and p95 are the value at position `q × (n − 1)` of the sorted values, interpolated linearly between its neighbours (NumPy's default, R type 7, `PERCENTILE.INC`, PromQL `quantile`). One value is every quantile of itself; in a small cohort p95 lies between the two highest values, which the drawer says.
- *Overlap:* Cliff's delta, `δ = (#{x > y} − #{x < y}) / (n_selected × n_other)` over all pairs of a selected value `x` and another value `y`. `+1`: every selected cell is above every other cell, the distributions do not overlap. `−1`: every one is below. `0`: a selected cell is as often above as below, as for identical distributions. It equals `2A − 1` for the probability of superiority `A` (the Mann–Whitney `U / (n₁ n₂)`).

**Decision: Cliff's delta as the overlap measure.**
*Alternatives:* (a) the overlapping coefficient of two histograms, (b) the Kolmogorov–Smirnov distance, (c) a difference of means in standard deviations.
*Rationale:* the question is which query tells the cohort apart. Cliff's delta answers it with one signed number that a reader can restate (δ = +0.94 without ties: the selected cell is the higher one in 97 % of the pairs), needs no bin width (a), no unit and no normality (c), counts an outlier once, is defined from one value per side, and is exactly 0 for identical samples. KS has no direction. Its known blind spot is a cohort that holds both the highest and the lowest values: δ is near 0 while min and max differ, which is why the table shows them next to it. Both cohorts are sorted once per query in typed arrays, O(queries × cells × log cells), inside the open drawer and never in a pointer handler.

**Copy formats.** The bar copies the distinct values that the selected cells have for one label, in natural order.

**Decision: that label is `selectionLabel`; without it, the label is chosen once, when a selection begins, and only for the copies.**
*Rationale:* with `zone → host → gpu` the cells are GPUs, but `gpu0` exists under every host and names nothing by itself, while the host is what a scheduler command or a query filter takes. Without configuration the panel takes the deepest hierarchy level whose values are unique in the grid, which finds `host` there, and for `zone → host`, `host → gpu` and a single `host` level; the top level always qualifies. Only hierarchy labels can be chosen, because cells keep only those.
That rule reads the data on screen: with one host on screen, `gpu` is unique. The first implementation applied it on every render, so narrowing the dashboard to one host turned an existing selection of hosts into `gpu0, gpu1`, for the copies and for the synced variable. Two rules prevent that. The label is chosen when a selection begins and kept until it is cleared (`SelectionState.autoLabel`), and the bar always names it ("3 host values:"). And the variable sync does not use the chosen label at all: it needs `selectionLabel`, because what other panels are filtered by must not depend on what happened to be on screen.

- *Regular expression:* `^(node-a001|node-a002)$`. Anchors make it exact where matching is a search and are harmless where it is anchored already (PromQL, LogQL label matchers); the group is a capturing one, which every dialect reads. **Decision: metacharacters are written as one-character classes (`.` → `[.]`, `[` → `[[]`), `]` as itself and a line break as `\n`, not with a backslash before the character.** `\.` is an invalid escape in a double-quoted PromQL or LogQL string, so a backslash-escaped expression cannot be pasted into a query. A class can, it is valid in RE2, PCRE, POSIX ERE and JavaScript, and `\n` means the same to the string and to the expression. Three characters have no form that a quoted string and an expression read alike: a backslash, `^` and a double quote. For a value with one of them the expression is still exact as an expression (`\\`, `\^`), but pasted between double quotes it is a parse error or, for a backslash, another expression: `^(a\\d)$` becomes `^(a\d)$` and matches `a1`. The copy cannot know where it will be pasted, so the bar shows a warning while such a value is selected (`needsQuoteEscaping`), and the tooltip of the button explains it. Checked against Prometheus 3.5 with 81 hostile label values, alone and in 300 random sets: every set without these three characters matches exactly its values in a double-quoted matcher.
- *List:* comma-separated; a value with a comma, a quote, a line break or outer white space is quoted as in RFC 4180.
- *Hostlist:* `node-a[001-003,007],login1`, as Slurm and pdsh read it. A range prints its numbers at least as wide as its first number, so zero padding is part of a name: `node-a01` and `node-a1` never share a range, while `098..101` do. One numeric field per name is compacted: the one with the most distinct values, the last one on a tie; names that differ elsewhere are listed separately. Digit runs over 15 digits are text. A value that is empty or contains `,`, `[`, `]` or white space cannot be written in the notation, and the button is disabled: both readers split a hostlist at white space as at a comma. Text after the bracket (`node-a[01-03].example.com`) is read by pdsh and by Slurm 23.11 and later; Slurm 23.02 and earlier reject it (their parser accepts only `,` or the end after `]`). The compaction keeps it, because fully qualified names are the common case for pdsh, and the README names the versions. `src/testing/hostlist.ts` is an expander written from the notation's rules; the property test requires `expand(compact(names))` to be exactly the input set.
- *Clipboard:* the Clipboard API, then the legacy copy command (the API does not exist outside a secure context). If both fail, the bar shows the text in a field to copy by hand. The result of a copy is kept with the values it was made of and shown only while the bar shows those values, so the field never holds the text of an earlier selection.

**Variable sync.** With `selectionVariable` and `selectionLabel` set, the panel keeps that dashboard variable equal to the selected values of the label. It writes with `locationService.partial({ 'var-<name>': value }, true)`, the API the plugin documentation gives for it, and reads with `getTemplateSrv().getVariables()`; both are present in every supported Grafana, also on the scenes-based dashboards of Grafana 12 and 13.

The rule behind every decision below: the bar says that a variable holds the selection only when the panel has read back that it does; another panel is never left filtered to hosts the user did not select without the bar saying so; and what a selection means (which label, which values) does not change while the selection exists.

**Decision: only a multi-value custom or query variable (raw values) and a text box (one regular expression) are written. Every other variable is refused, and the bar says why.**
*Alternatives:* (a) also write the regular expression to a single-value custom or query variable, which the first implementation did.
*Rationale:* Grafana formats and escapes a multi-value variable per data source when a query uses it, so the panel must not escape. A text box is inserted as text, so it gets the anchored expression above.
A single-value custom or query variable holds one of its options, and the expression is not one of them. Two things went wrong with (a) in a real Grafana with a Prometheus data source. A query variable that refreshes "On time range change" was put back to its first option at the next dashboard refresh, so the other panels showed one host that nobody had selected. And with "Include All option", the Prometheus data source escapes the value as a regular expression, so the written expression matched no host. Neither can be detected before the write, so these variables are refused.
Constant, interval, data source and ad hoc variables hold something else than label values. A name that is not in the dashboard is refused as well: writing it would only add a stray URL parameter.
Three kinds of value are refused although the variable is accepted. A value equal to `$__all` in a multi-value variable, because Grafana reads it as "All" and the other panels would show every host. An expression that `needsQuoteEscaping` in a text box: whether a backslash in a text box is escaped on its way into a query depends on the data source (Grafana's Prometheus data source doubles it, others do not), so the result cannot be promised. And any value in a multi-value variable that holds no value at all: Grafana drops an empty list from the URL and keeps what the variable holds, so its state could not be put back.

**Decision: one `VariableSync` for the page, shared by every FleetGrid panel; per variable it holds the claims of the panels, the value from before the first write, and what was written.**
*Alternatives:* (a) each panel remembers the previous value of the variable itself, as the first implementation did.
*Rationale:* a variable belongs to the dashboard, not to a panel. With (a), two panels that synced to one variable each took the other's selection for the "previous value": after both were cleared, the variable was left with the selection of the first panel, and the other panels stayed filtered by it. The shared object writes the union of all claims, so the selections of several panels, or of the copies of a repeated panel, add up. Withdrawing one claim writes the union of the rest, and withdrawing the last one puts the original value back. The bar of each panel says how many other panels share the variable.

**Decision: the status is "synced" only after the variable has been read back, and it is read again every second and on every URL change.**
*Alternatives:* (a) trust the write, as the first implementation did; (b) subscribe to variable changes.
*Rationale:* Grafana can change a variable at any time after a write: a refresh validates a query variable against its options again, and a viewer can pick another value. With (a) the bar went on saying `→ $name` while the variable held something else. `@grafana/runtime` has no event for "a variable changed" that exists in every supported version, so the sync polls the template service (one array read per second while a panel has a claim) and checks at once when the location changes, because Grafana mirrors variables in the URL. The outcomes are: *synced*, the variable holds what was written; *partial*, a multi-value variable holds some of the written values and nothing else; *changed*, it held what was written and now holds a value that was not written; *rejected*, Grafana never showed the written value within five seconds (it applies a URL change within milliseconds, also while a variable query is slow; the margin is for a busy page) and the variable holds a value that was not written.

**Decision: the sync writes the original value back only while the variable holds what was written or a part of it. It never writes over a value that it did not write, except with a new selection.**
*Alternatives:* (a) give the variable up as soon as it differs from what was written; (b) after *rejected*, write the original value back at once.
*Rationale:* with (a), a query variable whose options contain only some of the selected hosts kept those hosts after a dashboard refresh, the sync called that *changed*, and Clear left them in the variable: other panels stayed filtered by a host of a selection that no longer existed (seen in Grafana 11.6.0 and 12.4.0 with Prometheus). Every value of a *partial* variable came from the selection, whether Grafana dropped the others or a viewer unticked them, so the variable stays the sync's and gets its original value back when the selections end. It is not written again before a selection changes: Grafana would drop the same values at the next refresh.
After *changed* and *rejected* the variable is no longer the sync's. It is not written again until a selection changes, and it is not "restored" when the selections end, because the value in it is someone's choice. (b) was the first implementation of *rejected*. It cannot tell what Grafana made of the write from a value that a viewer picked in the five seconds after it, and it replaced that value. The price of the rule is that a value which Grafana itself puts in place of a selection stays until the viewer changes it; the bar says that the variable does not hold the selection.
A multi-value query variable is the case this exists for. Grafana accepts values that are not among its options, and puts the variable back to its options when it loads them again. That cannot be known before the write (the options may be loaded lazily, and a variable that loads them only once keeps the values), so the write is made and the read-back reports what happened.

**Decision: write once, 400 ms after the selection last changed, and only when the union of the claims differs from the last write.**
*Rationale:* every write re-runs the queries that use the variable. A run of Shift+clicks is one write, and `replace: true` keeps the browser history free of one entry per selection. A data refresh changes no claim, because a claim holds the label values remembered at selection time, not values read from the data. This is what ends the loop when the panel's own query uses the variable, directly or through another variable. In the first implementation the values came from the cells on screen: the write filtered the panel's data, the filtered data changed the automatically chosen label, the new values were written, and so on, 41 queries in 20 seconds. With remembered values and a configured label there is nothing for the data to change. Measured in Grafana 11.6.0, 12.4.0 and 13.3.1 with Prometheus: one query of the panel after the selection, none in the following 20 seconds.

**Decision: clearing puts back the value the variable had before the first write, if the variable still holds what was written or a part of it.**
*Alternatives:* (a) always set "All", (b) an option for the cleared value, (c) leave the last selection.
*Rationale:* "All" does not exist for every variable, and an empty list cannot be written, so the previous value is the only state that is defined for every variable. If the variable got a value in between that was not written, it is left alone (see *changed* above); when a selection then changes, the write records the value of that moment as the one to put back. The same restore happens when the selection becomes too large: the `var-` parameters may add at most 6,000 URL characters, which keeps a dashboard URL under the 8 KB request line that common reverse proxies accept. The bar then says so instead of syncing a part of the selection. The same restore also runs when the panel unmounts, because the selection ends there: Grafana re-creates the panel for the panel view and the panel editor, and without it the variable would keep filtering other panels for a selection that no longer exists. It is skipped when the page path has changed since the write, so that leaving for another dashboard never writes a `var-` parameter into that dashboard's URL. A reload, or coming back with the browser's Back button, keeps the URL's value while the viewer-local selection is gone; the variable is then reset with its own picker.

### Instant queries: on-demand range requery

Instant queries have no history at hand, so the panel re-issues the dashboard's targets as a range query when the popover needs series:

- Requery only when an instant target exists (a range query with a missing series must not trigger it).
- Targets are converted with `instant: false, range: true`, `format: 'table'` → `'time_series'`, `maxDataPoints: 100`, `intervalMs = max(15 s, span/100)`.
- Targets are grouped per datasource (mixed-datasource dashboards work) and `DataSourceApi.query` results are awaited whether they are Promises or Observables.
- The response frames do not pass through Grafana's field overrides, so their numeric fields have no `state.range`. Grafana's `Sparkline` reads the y range from it and throws without it, so the popover fills it from the values (`getMinMaxAndDelta`) when it is absent and keeps the range that panel data already carries.

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
| `selectionLabel` | hierarchy label a selection is copied and synced by (empty: chosen for the copies when a selection begins; no sync) |
| `selectionVariable` | multi-value or text box dashboard variable kept equal to the selected values of `selectionLabel` (empty: no sync) |

The **Color scale overrides** editor supports add/remove/reorder and multiple matchers per rule. It derives refId, label-name, and sample-value suggestions from both table and time-series query results while allowing custom values. Inline validation covers missing matchers or labels, invalid regex, non-finite endpoints, neither endpoint set, and `min >= max`; min-only and max-only rules are valid.

Cell selection has no option to switch it on: it does nothing until Shift is held. Its two options only say what a selection is exported as, both defaults write nothing, and the variable sync needs both.

**Decision: restrict `reduceCalc` to an allowlist of numeric reducers rather than the full standard Calculation picker.**
*Rationale:* non-numeric reducers (`allValues`, `uniqueValues`, …) produce values the color pipeline cannot render; offering them would be an invitation to a broken panel. A guarded Select with a numeric allowlist keeps the standard vocabulary while making invalid states unrepresentable.

The flow overlay's options are additions with their own table in §15. Its only switch is `flowRefId`: empty (the default) leaves the panel exactly as it was.

Every option is stored in the dashboard JSON under its path, so a path is never reused or renamed without a migration. The selection options and the flow options have paths of their own (`selection…`, `flow…`), and a test in `src/module.test.ts` lists all stored paths and requires each to occur once.

## 11. Plugin metadata and toolchain

- id `yuuk1-fleetgrid-panel`, name `FleetGrid`, `grafanaDependency: ">=11.6.0"`.
- Scaffold: `@grafana/create-plugin@7.0.5` (pinned). **Rationale:** reproducibility of regeneration, and 7.0.5 builds against `@grafana/* ^12.x` — closer to the supported minimum (11.6) than newer scaffolds targeting 13.x, reducing the risk of accidentally depending on 13-only APIs.
- The pinned scaffold conflicts with the floating `@grafana/tsconfig@2.2.0` (`moduleResolution: "bundler"` vs. the scaffold's ts-node `module: "commonjs"` → TS5095). Fixed by overriding `moduleResolution: "nodenext"` in the ts-node block of the **root** `tsconfig.json` (mirroring upstream create-plugin 7.x), because `.config/` is tool-managed and must not be edited.
- The Playwright tests in `tests/` are type-checked and linted with the source. The root `tsconfig.json` widens the scaffold's `rootDir` and `include` (which cover only `src/`), and the root `eslint.config.mjs` selects `tests/**/*.ts`: the scaffold's `./tests/**/*` entry ends in a wildcard, so ESLint applies it only to files that another entry already selects, and no entry did.
- `jest-canvas-mock` is imported from the root `jest-setup.js` **after** `.config/jest-setup` — the scaffold's setup (run in `setupFilesAfterEnv`) overwrites `getContext`, so the plan's original `setupFiles` placement produced a silently non-functional mock. Load order is the constraint; a comment in the file records it.

## 12. Testing strategy

- **Unit (Jest + jest-canvas-mock):** every pipeline stage TDD-tested as a pure function; range resolution covers refId, exact/regex, AND, order, partial endpoints, table/time-series provenance, conflict fallback, and processor reuse; renderer covers cell-specific colors as well as split regions, missing color, and contrast text.
- **Component (React Testing Library):** option editors (including range-rule add/remove/reorder, suggestions, and validation), panel wiring (multi-range legends, actual-range tooltip, selector, scroll coordinates, data-link priority, link menu, popover close paths, requery race with deferred promises).
- **E2E (`@grafana/plugin-e2e` + Playwright):** a provisioned TestData dashboard (`uid: fleetgrid-e2e`, generic zone/host/gpu data with unpadded host numbers so natural order differs from lexicographic order) exercised against the default Grafana image **and** `GRAFANA_VERSION=11.6.0`. A dedicated two-zone table panel gives equal values different maxima and verifies the legend, each tooltip range, and different canvas fills. Canvas assertions map CSS coordinates to backing-store coordinates and use locally uniform colors rather than screenshot equality, tolerating DPR and cross-version anti-aliasing differences.
- **Cell selection:** selection state, statistics, formats and variable sync are unit-tested as pure functions; fast-check properties cover the hostlist round trip against the independent expander, the regular expression (matches exactly the values), the list, Cliff's delta against the pair count of its definition, quantile bounds, and the region hit test against a scan. The gestures are tested in jsdom with a minimal `PointerEvent` (jsdom has none) and in E2E on a dedicated panel, which also checks the clipboard, the drawer and the `selected_hosts` variable in the URL. The variable sync is tested at three levels: `VariableSync` against a stand-in for Grafana that a test can make behave like Grafana or like a viewer (reset at a refresh, a write that is not kept, a change by hand); the panel with that stand-in (data refreshes, the self-filtering query, two panels, unmount); and E2E on a second dashboard (`uid: fleetgrid-selection-sync-e2e`) whose panels name a multi-value variable (two of them the same one), a text box, a single-value variable, a query variable whose options are not hosts, and a variable without a selection label, with a text panel that shows what each variable gives to a panel that uses it.
- **Flow overlay:** the data stage has example tests and a model-based property test (every edge row lands in exactly one edge or one counted reason; values aggregate like a naive reference; ranking, filter and hover index agree with it), the geometry has example and property tests, and the draw pass is checked through the recorded canvas calls. Component tests cover what a hover paints (the focus layer only) and that a panel without an edge query has no overlay. The first E2E dashboard (`uid: fleetgrid-e2e`) has a `Flow Overlay` panel (a six-hop ring over two zones, a pair in both directions, an edge without a value, one row to a host outside the grid, one self-edge). Whether arcs are legible on a dense grid is a judgement that needs eyes: it was checked on screenshots in the light and dark themes, not by an assertion.
- Checks that genuinely require human eyes or a live Prometheus (visual sparkline quality, in-cell unit suffix at various widths, instant requery against a real datasource, split-region visuals, minimum-cell-size boundary) are explicitly listed as manual follow-ups rather than silently claimed.

## 13. Out of scope

Deliberately not implemented (YAGNI, confirmed during design): Conditions-style expression or threshold DSL (range matchers select only Min/Max), modifier-click actions other than the Shift selection gestures, a freeform lasso, selecting cells with the keyboard or by touch, saving a selection in the dashboard, pinned/frozen cells, zoom/pan of the grid, custom URL template mechanisms outside standard Data Links, and datasource-specific code paths (the pipeline is frame-shape-based and datasource-agnostic; Prometheus/VictoriaMetrics are the design targets, not a hard dependency). For the flow overlay: animated flow particles and every other continuous animation, a selection mechanism of its own, emphasising the edges of the selected cells, and paths given as a list of members instead of hops (§15).

## 14. Known limitations / future work

- Verification against a live Prometheus/VictoriaMetrics (including instant→range requery behavior) is still outstanding; README states this.
- A Shift+drag does not scroll the grid when it reaches the edge of a scrolled panel, and Shift+wheel scrolls sideways in browsers. To select beyond the visible part, scroll and drag again: drags add to the selection.
- The variable sync was verified with a real Prometheus data source on Grafana 11.6.0, 12.4.0 and 13.3.1, by scripts that are not part of CI: for multi-value custom and query variables (with and without "All", with a custom all value, refreshing on load and on time range change) and a text box, a neighbouring panel was filtered to exactly the selected hosts before and after two dashboard refreshes; for single-value custom and query variables, a constant and an interval, nothing was written and the bar said why. CI covers the same rules with TestData only.
- How a synced value reaches a query is decided by Grafana and by the data source of the panel that uses the variable. With Grafana's Prometheus data source a multi-value variable is exact for every tested value except one with a double quote or a line break, for which the other panel's query fails with an error.
- A multi-value query variable drops values that are not among its options when it loads its options again. The bar then says how many of the selected values the variable still holds, or that the variable was changed; the sync does not prevent it. When no selected value is among the options, Grafana sets the variable to a value of its own ("All" or an option), and that value stays after Clear.
- The hover tooltip passes on only a Shift press that is over the cell it shows. In a small panel it can still lie under the pointer and take a plain click, and where it covers other cells, a Shift+click on it selects nothing.

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
| Edge query | The query named by `flowRefId` (spaces around it are ignored). Its frames and its target leave the cell pipeline: no cells, no selector entry, no drilldown requery, no row in the cohort comparison of a cell selection (§9), and no suggestions in the editors of the cell options (`cellFrames` in `src/options/suggestions.ts`). |
| No rows | A query that ran and returned no rows draws nothing and is **not** a warning: it is the healthy state of a query that filters in the data source. A refId that no query of the request has (or only a hidden one) is a warning. The request's visible targets tell the two apart (`flowQueryState`); without a request and without a frame the panel says only that there is no data. |
| Row | One directed pair: a source, a destination, a value. Table frames and time-series frames are read as for cells; a range series is reduced with `reduceCalc`. |
| Endpoint | `flowEndpoints` maps a hierarchy label to the edge query's source label and destination label. The endpoint's value is compared with the **raw** value of that hierarchy label on the cells (`CellModel.labelSets`). |
| Level | An endpoint resolves at the deepest mapped hierarchy level: to a cell when that is the leaf level, otherwise to the group. All edges of a panel resolve at the same level. |
| Edge | One per ordered pair of nodes. Its value is the worst of the rows of the pair (`flowWorst`). A→B and B→A are two edges. |
| Value | `number`, or `null` when none of the rows has a finite value. `null` is "unknown": drawn dashed in a neutral color, never 0, and left out by a filter (the legend then says how many). |
| Not drawn | A row without an endpoint label, with an endpoint that matches no node, or with one that matches several nodes; and a self-edge (both ends resolve to one node). All four are counted, and the worst value among the first three and among the self-edges is kept (`excludedWorst`, `selfWorst`). The legend gives both counts with that value in its visible text (`3 rows left out, worst 4.5%`); the first three are also in the warning banner, with examples. |

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

Pairwise data grows with the square of the fleet: 1,000 hosts can report a million pairs. Two hard bounds keep the panel's work small for such a result:

| Bound | Value | When it binds |
|---|---|---|
| Rows resolved (`MAX_FLOW_ROWS`) | 20,000 | The worst 20,000 rows by value are resolved into edges; the others are left out. The legend reads `worst 20000 of N rows used` and the banner asks to narrow the query. Only the value of each row is read for the ranking, which is the one cost that still grows with the result. |
| Arcs at rest (`flowRestArcs`) | 100 by default, 1–500 | The worst edges that pass the filter are drawn, and the legend reads `100 of N edges drawn, worst first` in the warning color. |
| Arcs in focus (`MAX_FLOW_ARCS`) | 500 | The arcs of a hovered node, and the most that the resting picture can be set to. |

Edges are ranked by value in the worse direction, ties by source and destination key. The ranking is therefore the same for any order of the query result.

**Decision: the resting picture holds 100 arcs unless the user asks for more.**
*Alternative:* draw up to the hard bound of 500 (the first implementation).
*Rationale:* the hard bound was chosen for the paint time, not for the reader. A screenshot of 500 arcs over 1,000 hosts shows a mat of lines: the cells under it cannot be read, and the one red arc among 499 orange ones is not easier to find than in a table. The overlay is there to make the degraded paths stand out, so its default has to leave the grid readable. 100 arcs is still a dense picture but the cells show through, and the legend turns to the warning color and says `100 of N edges drawn, worst first`, which tells the user to filter. The number is an option because the right value depends on the size of the grid; it cannot exceed the hard bound. The focus keeps the hard bound: the edges of one hovered node are what the user asked to see.

**Decision: the rows of an oversized result are ranked by value before they are cut.**
*Alternative:* read the first 20,000 rows (the first implementation).
*Rationale:* which rows come first is the data source's order. With 25,001 rows whose only degraded row was the last one, that row was never read, while the legend said `500 of 19999 edges drawn, worst first`. The legend's claim has to be true for the whole result. So when there are more than 20,000 rows, the value of every row is read (`forEachRowValue`: one number per table row, one reduction per series), the 20,000 worst are found with a bounded heap in O(n log 20,000) for any order, and only those rows are turned into label sets and edges. Because an edge takes the worst of its rows, the edges of the worst rows have exactly the values they would have with all rows. Rows without a value share the bound as arcs do; rows that tie with the least bad row that is kept are taken in the order of the result. What remains unbounded is the value scan: the fastest of several runs took 62 ms for 20,000 rows (no scan), 61 ms for 100,000 table rows, 227–306 ms for 1,000,000 table rows and 192 ms for 100,000 single-point series (Node 22, shared container). A cap on the scan was left out: it would bring back "the first N rows" at a larger N, and a result of that size does not reach a browser panel.

**Decision: edges without a value share the arc bound instead of being cut first.**
*Rationale:* an edge without a value cannot be ranked, and the first implementation put it last. With 600 healthy edges and 20 whose probe returned nothing, none of the 20 was drawn, while the legend's tooltip said they were dashed. A probe that returns nothing may be the most broken path of all. When the edges do not all fit, the edges without a value now get what the valued ones leave free, and at least half of the bound (`shareFlowBound`); the same rule applies to the edges of a hovered node. They cannot take the whole bound either, because the edges that are known to be degraded must stay. The legend's visible text says how many of them are drawn (`250 of 300 edges without a value drawn`), and, with a filter, that none is (`12 edges without a value not drawn`).

| Step | Cost | Runs when |
|---|---|---|
| Find and count the edge query's frames | O(frames × fields); no value is read | data or options change |
| Rank the rows of a result with more than 20,000 rows | O(N log 20,000) for N rows; one value per row, three typed arrays of N | data or options change |
| Resolve endpoints, take the worst row per pair | O(R), R ≤ 20,000 rows, hash lookups | data or options change |
| Endpoint index | O(cell label sets × mapped levels) | data or options change |
| Filter and rank | O(E log E), E ≤ R edges | data or options change |
| Hover index (node → edges, path → edges) | O(E + hops) to build | data or options change |
| Node rectangles | O(cells) | layout changes |
| Paint the resting layer | O(min(E, `flowRestArcs`)) arcs, at most 500 | data, options, layout or theme change |
| Look up a hovered node | O(its edges + the edges of its paths), at most 500; independent of E | the hovered **node** changes |
| Paint the focus layer | O(focused arcs), at most 500 | the hovered node changes |
| Pointer move inside a cell or a group | nothing | — |

The hover lookup is covered by a test that counts the edges it reads on a 10,000-edge model. A timing test builds the model just above the row bound (22,350 rows, 20,000 distinct edges) against a budget that only a quadratic step would exceed. Measured with Node 22 on the container described below, that build took about 60–100 ms at best, and looking up and summarizing a node with 270 edges in it took 0.35 ms.

Paint times were measured in headless Chromium without a GPU (software rasterizer) on a shared 4-core container, on a 1531 × 773 px canvas, by drawing and then forcing the canvas to rasterize. They are an upper bound for one environment, not a promise:

| What is painted | Device pixel ratio 1 | Device pixel ratio 2 |
|---|---|---|
| 500 arcs between random points of the canvas | about 30 ms | about 75 ms |
| 500 arcs of at most 300 px | about 11 ms | about 25 ms |
| The focus layer for a host with 38 edges, in the panel | 5 ms median, 11 ms worst | 14 ms median, 49 ms worst |

In the panel, with 1,000 hosts and 25,000 edge rows, the resting layer took about 60–100 ms per paint at ratio 1, including the first color lookups. That is the reason for the hard bound of 500 and for keeping this layer out of the hover path. With the default of 100 arcs at rest a paint is a fifth of that.

### Drawing

**Decision: two canvases stacked on the cell canvas — the arcs at rest and the arcs in focus — instead of drawing on the cell canvas.**
*Alternatives:* (a) draw the arcs at the end of `renderCanvas`; (b) one overlay canvas that is repainted with the other arcs dimmed on every hover.
*Rationale:* the panel draws when something changes, and hover changes often. With (a) every change of the hovered cell would repaint up to 15,000 cells. With (b) it would repaint up to 500 arcs, which costs tens of milliseconds without a GPU (table above). With two layers a hover paints only the focused arcs, typically a few dozen. The resting layer is dimmed by setting its CSS `opacity`, which the browser composites without painting. Both layers start at the cell canvas's origin, so all three share the content coordinate system and scroll together; pointer events pass through them. A layer is as high as the cell canvas. It is as wide as the cell canvas plus a margin where the panel is wider than the grid: a grid that is narrower than its panel (zones stacked in one column) would otherwise leave an arc no room beside the grid. A layer never makes the panel scroll: it is not wider than the visible width unless the grid is.

The height of the cell canvas is the larger of the grid and the grid's box, and that box loses the height of the selection bar while cells are selected (§9). The layers are given the same box (`gridViewportH` in `FleetGridPanel`), not the panel body. A layer sized from the body would be higher than the cell canvas by the bar's height, and the grid would scroll past its last row.

**Decision: the arcs lie over the cells and their selection rings, and under the rubber band.**
*Alternative:* draw the selection rings over the arcs.
*Rationale:* the stack, bottom to top, is the cell canvas (cells with the selection rings of §9, group labels, the pinned label), the resting layer, the focus layer, the rubber band of a Shift+drag, the tooltip, the popover and the link menu. The canvases follow each other in the DOM; the others lie above by `z-index` (5, 10, 20, 30). A ring is a mark of its cell, like the fill, and it is drawn with the cell on the one cell canvas; rings over the arcs would need the separate selection canvas that §9 rejected. So an arc runs over a ring as it runs over a fill, and its halo cuts both. The band is what the viewer is drawing at that moment, so it is over the arcs; it lets pointer events through, as the layers do.

**Decision: the margin beside the grid is bounded, so a layer is never more than twice the cell canvas.**
*Alternative:* a layer as wide as the panel (the first version of this fix).
*Rationale:* the height of a layer is the scroll length of the grid, so every pixel of width is paid for over the whole length. For 3,400 hosts in four columns (a grid of 68 × 28,066 px) in a panel 1,550 px wide, a layer of the panel's width held 44 megapixels: 174 MB at device pixel ratio 1 against 8 MB for the cells, 696 MB at ratio 2, and in a wider window more pixels than Chromium paints at all, so nothing was drawn while the legend counted edges. The margin is now `min(panel width − grid width, grid width, 160 px)`: never beyond the panel, never more than the grid's own width, and never more than an arc can use (the apex of the largest arc is 140 px from its chord). With this margin an arc in a narrow grid bulges less than it would like (rule 3 of the arc geometry); that is accepted. Measured in Chromium for the same grid, in megabytes of backing store (width × height × 4):

| Window, pixel ratio | Cell canvas | Resting layer | Focus layer (after the first hover) | Resting layer before the bound |
|---|---|---|---|---|
| 1600 px, 1 | 7.6 | 15.3 | 15.3 | 174 |
| 1600 px, 2 | 30.5 | 61.1 | 61.1 | 696 |
| 2600 px, 2 | 30.5 | 61.1 | 61.1 | 1,145 (not painted) |
| 2600 px, 3 | 68.7 (not painted) | no store | no store | 2,576 (not painted) |

So the overlay costs at most two layers of at most twice the cell canvas each, whatever the panel's width; for a grid that fills its panel each layer is exactly the cell canvas.

**Decision: a layer that the browser cannot paint is not allocated, and the legend says so.**
*Rationale:* Chromium paints nothing on a canvas with a side over 65,535 device px or more than 268,435,456 device px in all, and reports no error. A legend that reads `3 edges` over a picture without arcs is the worst outcome for a panel that exists to show degraded paths. `flowLayerSize` therefore checks the size against these two limits: a layer that does not fit with its margin gets the cell canvas's size, and when that does not fit either (last row of the table: the cell canvas itself is not painted) the layer holds no store and the legend reads `3 edges not drawn: the grid is too large for the overlay`. The limits are Chromium's; a browser with lower limits fails at a smaller grid, for its cell canvas and its layers alike. This extends the "single canvas" decision of §2 rather than breaking it: the number of DOM nodes is still constant, and the layers exist only while an edge query is named.
*Cost:* memory. Each layer is a backing store of the size given below. The resting layer holds none while it has no arcs (always, in `On hover` mode); the focus layer allocates one at the first hover and keeps it, because allocating a canvas on every hover costs more than clearing it. So the overlay uses up to two extra canvases.

**Decision: static arcs with an arrowhead, no flow particles.**
*Rationale:* particles need a `requestAnimationFrame` loop that repaints for as long as the panel is mounted. FleetGrid is built to paint only on change, dashboards hold many panels, and a wall display runs for days; an always-running loop per panel is a standing CPU cost for a cue that an arrowhead gives for nothing. Motion also has to be switched off for `prefers-reduced-motion`, so the static encoding has to exist and be sufficient anyway. Animation is therefore left out, not made optional.

**Arc geometry** (`flowArc`): a quadratic Bézier between the centres of the two node rectangles.

- It bulges to the **left of its direction of travel**. A→B and B→A are thus two curves that form a lens, never one line.
- The distance of the control point from the chord grows strictly with the chord's length and levels off (`0.35·L / (1 + L/500)`, at least 8 px). Arcs of different lengths over one row of cells therefore nest like an arc diagram instead of covering each other.
- **The whole arc stays on its canvas, and its apex keeps 24 px from the edge**, measured along the line on which the arrowhead and the hop number sit. The bulge is limited per canvas edge in closed form. With `d0` and `d1` the distances of the arc's two ends from an edge and `k` the part of the arc's normal that points at that edge, the apex keeps the margin when `bulge ≤ (d0 + d1)/k − 2·24`, and no point of the arc crosses the edge exactly when `bulge ≤ (√d0 + √d1)² / (2k)`. The second limit is needed because an arc with one end near an edge leaves the canvas near that end, not at its apex. The rules, in order:
  1. Its own side has room for the bulge: it bulges there.
  2. Otherwise, if the other side has room for 1.6 times the bulge, it bulges to that side, 1.6 times as far (an arc along the top row). It is then outside the arc of the opposite direction, which is already there, so the two do not coincide.
  3. Otherwise it stays on its own side and bulges only as far as fits, down to a straight line.
  4. If rule 3 leaves both directions with a bulge under 8 px (the canvas has no room on either side: a panel as high as one row of cells), each bulges by up to 8 px on its own side, into the margin but not off the canvas, so that the two directions are still two lines. Only in this case can an arrowhead touch the canvas edge; the hop number is then moved back onto the canvas.
  *Alternative:* share the side that has more room between the two directions when neither has enough (the first version of this fix). *Rationale against:* the separation of the two arcs then shrinks with the room and reaches zero, and a point that is a fraction of a pixel inside or outside the margin changed the result; with the rules above the control points of the two directions are more than 4 px apart on every canvas (a property test checks this, and that every point of an arc is on the canvas).
- The **arrowhead sits on the middle of the arc**, where a quadratic Bézier runs parallel to its chord. *Alternative:* arrowheads at the destination. *Rationale:* many arcs end on one cell, and their arrowheads would pile up on it and hide it; the middles of the arcs are spread out.
- **An arc between groups ends at the centre of its group, under a hub, and its groups are outlined on both layers.** A group's anchor is the bounding box of its cells, and an arc ends at the centre of that box, exactly as for a cell. That point alone looks like an edge of the cell in the middle of the group (or of the gap between four cells). So both layers outline every group that is an end of one of their arcs, and close each arc with a hub: a dot at the group's centre in the color of the outline, drawn over the ends of the arcs (resting layer: 1 px outline and hub in the secondary text color; focus layer: 1.5 px, primary text color). A cell has no such mark, and all arcs of a group meet in its hub, so the hub reads as a mark of the outlined group.
  - *Alternative (tried and removed):* draw only the part of the arc between the two frames, from where the curve leaves the source's box to where it enters the destination's box. It had two defects. With elongated frames (a host drawn as one row of 16 GPUs) the centre-to-centre curve passes through the destination once and comes back, and the part "before it enters the destination for good" was a small loop with both ends on the destination and none on the source: 111 of 8,190 host pairs in one such layout. And groups are 4–8 px apart, so an arc that ends on a frame ends in the seam between two frames, where it cannot be read which of the two it belongs to (64% of the arcs in random grids ended within 8 px of a frame that was not theirs). An end at the centre is as far from every other group as it can be.
  - *Rule kept from this:* the end of an arc never depends on where a curve crosses a rectangle. A property test builds real layouts with host groups of any shape and checks that every arc starts at the centre of its source and ends at the centre of its destination.
  - *Alternative:* attach the arc to the middle of a side of each frame. The arc crossed the cells of its own group for groups of different sizes, and its end is in the seam as well.

**Legibility on a dense, colored grid.** Each arc is stroked twice: first 2 px wider in the panel's background color (a halo), then in its own color. The halo keeps the arc readable on any cell color in the light and dark themes, and separates it from the arcs drawn before it. Arcs are drawn best first, so the worst are on top; arrowheads and hop numbers are drawn after all arcs. The width follows the cell size (1.25–2.5 px) so that arcs do not bury 6 px cells; focused arcs are 1.6 times as wide. The color comes from the edge query's standard field config (`getDisplayProcessor`, the same call as for cells), so thresholds, color schemes and overrides by query work unchanged.

**Decision: the automatic color range is taken before the filter and anchored at the healthy end.**
*Alternative:* the range of the edges that are drawn, as for the cells' displayed values (the first implementation).
*Rationale:* with a continuous scheme and no Min/Max, a range over the drawn edges made the filter repaint them: with losses 0 and 7 and "worse than 1", the only drawn edge was green, with a legend of `7 – 8`; unfiltered, the same edge was red. In the configuration that shows only degraded paths, the degraded paths got the healthy color. The range now spans every valued edge before the filter and includes the threshold. When higher is worse it also includes 0, because an edge query that filters in the data source (`> 0`) returns only degraded pairs, and the least degraded of them would otherwise sit at the healthy end. Lower-is-worse metrics have no such natural healthy end, so there the threshold is the only anchor. The rule is kept to these three clauses on purpose, so that a user can predict the range: every valued edge before the filter, the threshold, and 0 when higher is worse. Field-config Min/Max still win, each end on its own, whether they come from the standard options or from an override for the edge query (Grafana applies both to the field config before the panel reads it), and thresholds are absolute anyway. What the overlay cannot do is choose the scheme: `flowWorst` does not invert colors, because it cannot know whether the user already picked a scheme whose low end is the alarm color. A silent inversion would make half of those users' panels wrong. Instead the legend's scale says in words which end is the bad one (`higher is worse` / `lower is worse`), so a green arc at the worse end cannot be read as healthy without contradicting the text next to the scale, and the README tells how to choose the scheme.

**Decision: every arc is its own path.**
*Rationale:* painting all arcs of one color as a single path looked like the cheaper way and was implemented first. Measured in Chromium, one path with 1,000 arcs took 2–3 times as long as 1,000 single strokes at device pixel ratio 1 and was no faster at ratio 2: the strokes of one path overlap everywhere, and the rasterizer has to resolve that. Single strokes also let each halo cut through the arcs below it.

### Hover

Hovering a cell puts the edges of its node in focus: the cell itself, or its group at the endpoint level. The focus also contains the other edges of every path that those edges are on, so pointing at one member of a ring shows the whole ring. The focused arcs are drawn on the focus layer, the resting layer is dimmed, and the tooltip gains the node's outgoing and incoming edge counts, its peer count, its worst peer with the formatted value, and its hops. A node without edges puts nothing in focus and dims nothing.

**Decision: the focus is the hovered cell's node if it has edges, otherwise the node of the open drilldown popover.**
*Alternative:* the hovered cell first, whatever it has (the first implementation).
*Rationale:* a popover pins a cell: the user reads its sparklines while its edges stay emphasised. With the first rule, moving the pointer over any cell without edges on the way to the popover dropped the focus, although that cell had nothing to show. A hovered cell that has edges still wins, because the pointer is the more recent intent. The tooltip summary is always the hovered cell's, never the pinned one's: a tooltip that describes another cell than the one it points at would be wrong.

The focus is drawn from the filtered edges, not from the resting arcs, so a hover can show edges that **Arcs at rest** left out. The filter is not lifted by a hover: it defines which edges exist for drawing.

**Decision: the focus is a set of node keys.**
*Rationale:* `flowFocusEdges(model, nodeKeys)` takes any number of nodes. Today the panel passes one node: the hovered cell's or the pinned cell's. The nodes of the selected cells (§9) could be passed without a change to the data stage or the draw pass; the panel does not pass them (next decision). The overlay builds no selection mechanism of its own.

**Decision: a Shift press has the pointer to itself, and a cell selection does not change the arcs.**
*Alternatives:* (a) keep the hover alive during a Shift press; (b) put the edges of the selected cells in focus.
*Rationale:* the overlay and the cell selection read the same pointer on the same container. The overlay follows the hovered cell; the selection takes a press that starts with Shift, from pointer-down to pointer-up (§9). Where both apply, the selection wins: the press ends the hover, so the tooltip and the hover's focus go, the resting layer is at full opacity again unless a popover is open, and the pointer hovers nothing until the button is released. The next pointer move after the release hovers again, on a selected cell as on any other. With (a) the focus layer would be painted for every cell that a drag crosses, and the arcs at rest would be dimmed, during a gesture that is about cells. Without Shift nothing is different: a hover, a click and the popover's pinned focus work on selected cells as before, and none of them changes the selection.
The focus that an open popover keeps is not the hover's, and the press leaves it alone: it lasts exactly as long as the popover, as before. Whether a press closes the popover depends on the host, because the panel closes its popover on a pointer-down that reaches the document. Grafana 11.6.0 lets the event through: a press outside the popover, with or without Shift, closes it and ends its focus. Grafana 12.4.0 stops the pointer-down above the panel: a plain click on the grid still closes or moves the popover through the click handler, but the click that ends a Shift press is swallowed (§9), so the popover and its focus stay through a selection gesture. Both were seen in a browser on these two versions. The overlay adds no rule of its own here. Closing the popover on a Shift press would change what §9 settled for the two (Escape leaves the selection alone while a popover is open, so they are meant to exist together), and it is not needed for the selection to work.
(b) is what the set of node keys makes possible, and it is left out on purpose. A selection exists to be compared and exported; it can hold every cell of the grid, while the focus is bounded to 500 arcs and dims the rest, so a large selection would show an arbitrary part of its edges and hide the resting picture until it is cleared. It would also give the focus a third source next to the hover and the popover, with an order to define and to explain. So a selection paints no arc: it repaints the cell canvas for the rings, and neither layer. The one repaint of the layers at the first selected cell is for their size, because the selection bar takes height from the grid's box (see Drawing). Emphasising the edges of a selection is a possible later addition with its own decision.

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
| `flowRestArcs` | whole number 1–500 (unset — 100); hidden in hover mode |
| `flowWorst` | `high` (default) / `low` |
| `flowThreshold` | number (unset — no filter) |
| `flowOrderLabel` | label name (`''`) |
| `flowPathLabel` | label name (`''`) |

Unknown or missing values are normalized at runtime (`resolveFlowConfig`), so a dashboard saved before these options existed, or edited by hand, behaves like the defaults. The refId and the label names of the edge query are used without the spaces around them (`"E "` names query E); a hierarchy label is compared as the levels store it. An edge query without endpoint mappings draws nothing and says so in the banner and, in a few words, in the legend. So does one with a mapping that is incomplete or that names no hierarchy label: such a mapping is not skipped, because the mappings together decide the level at which the endpoints resolve, and drawing with the remaining ones would show the edges at a level nobody asked for.

**Decision: everything that makes the picture incomplete, or empty by mistake, is in the legend's visible text.**
*Alternative:* the warning banner and the legend's tooltip only (the first implementation).
*Rationale:* the banner is one line of 20 px, shared with the cells' warnings, and it cuts long texts with an ellipsis; a tooltip needs a pointer, and a wall display has none. In a panel a quarter of the dashboard wide, the notice that rows were left out was not readable at all. The legend wraps and breaks long words, so its text is readable at any panel width. It therefore carries, in the warning color: the arcs that the draw bound left out, the rows that the row bound left out, the edges without a value that are not drawn, the rows that match no cell and the rows within one node (each with the worst value among them, so a degraded row without an arc is still seen), and the reason why nothing can be drawn (`no query "E"`, `endpoint mapping incomplete`). The banner keeps the long form with examples, and each of its entries has its full text as its title. That `title` attribute is on every warning of the banner, also on the cells' warnings of a panel without an edge query: it is the one difference in the DOM of a dashboard that does not use the overlay (its pixels, sizes and scroll extents are unchanged).

### Known limits

- The row bound is applied before the endpoints are matched. Of a result with more than 20,000 rows, rows whose endpoints are not in the panel use up the bound like any other row; when the 20,000 worst rows are all of that kind, a degraded edge inside the grid is not read. Matching first would need the label values of every row (the cost that the bound exists to avoid: today only one number per row is read, 0.27–0.41 s and about 47 MB for a million rows), and it would change what the row counts in the legend mean. The panel does not hide the case: the legend reads `worst 20000 of 30000 rows used, 10000 rows not read` and `20000 rows left out, worst 59`, and the banner says that rows that match no cell count towards the limit and asks to restrict the query to the hosts of the panel.
- Frames are selected by refId. A transformation that merges or renames the queries removes the edge query.
- All edges resolve at one hierarchy level. Edges between a cell and a group are not supported.
- A cell selection (§9) does not put the edges of its cells in focus. To read the edges of a selected cell, hover it.
- The overlay has not been verified against a live Prometheus / VictoriaMetrics, and its paint cost has not been measured with a GPU.
