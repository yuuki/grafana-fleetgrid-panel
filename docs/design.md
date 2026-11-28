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

**Decision: a Shift press on the hover tooltip goes to the cell under it.**
*Rationale:* the tooltip is placed inside the panel, and in a small panel there is no room beside the pointer, so it is drawn over the pointer. It keeps presses to itself so that its text can be selected and its content scrolled. A Shift+click on a cell then did nothing whenever the tooltip had been drawn first: in a Grafana 12.4.0 panel of 356 × 206 px, four of six Shift+clicks were lost. A press with Shift is never a text selection in the tooltip that matters, so the tooltip lets it through, and the gesture reads the cell from the pointer position. A press without Shift stays with the tooltip as before.

**Decision: a rectangle, no freeform lasso.**
*Rationale:* cells are axis-aligned squares in nested grids, so a rectangle that takes every cell it overlaps is predictable to the pixel, and its hit test is exact. A freeform outline needs a rule for cells it cuts through, which a user cannot see while drawing. Arbitrary shapes (half a rack, a checkerboard) are built from rectangles and single-cell toggles, because drags add and Shift+click toggles.

**Decision: a selection is a set of hierarchy paths, each with the label values its cell had when it was selected; a selected path with no cell stays selected.**
*Alternatives:* (a) layout indices or pixel regions, (b) cell objects, (c) dropping selected cells that leave the data, (d) paths only, reading the labels from the current data.
*Rationale:* the path is the cell's identity in the data model (`pathKey`), so a selection means the same cells after a data refresh, a new layout, a resize, a metric switch or a re-sort; indices, pixels and cell objects do not survive a new model. A node that stops reporting disappears from an instant query's result, and it is often exactly the node the operator selected. Dropping it silently would shrink the cohort and the copied host list without notice, so its key is kept, the bar counts it as "not in the current data", it is on neither side of the comparison (it has no value), and it is ringed again when its cell returns.
Reading the labels from the current data (d) was the first implementation, and it made the meaning of a selection depend on the data: when the selected hosts left the data, the copies became empty and the synced variable went back to "All", so the other panels showed every host while the bar still named the selection. A selection now remembers the label sets of each cell at the moment it is selected (`SelectedCell.labelSets`), and copies and the variable are built from those. The bar says how many of the values come only from cells that are not in the current data. A cell that is selected again keeps its first snapshot; label values of a path's hierarchy levels cannot change without the path changing, so the snapshot does not go stale.
Changing the hierarchy levels clears the selection: the paths then name other cells. Like the metric and category selections, it is viewer-local and never saved.

**Decision: the rubber band is one DOM element moved by writing to its style; the selection changes at pointer-up; selected cells get a ring on the same canvas.**
*Rationale:* a pointer move must not render, lay out or repaint. The band is rendered once, hidden, and `useCellSelection` keeps the gesture in a ref, so a move costs one region query and four style writes. The selection is React state and changes once per gesture, which repaints the canvas once, as a legend-chip highlight does. The ring reuses the band geometry of the category highlight ring (device-pixel aligned, capped so the fill survives) in the theme's maximum-contrast colour, drawn inside `drawCell` so group labels and the pinned label stay on top. It is 1 px without a separator on cells below 14 px: selected cells are selected to be compared, so their fill must stay readable. A second canvas for the selection was rejected: it doubles the backing store, and it breaks the single-canvas assumption that the E2E tests and the pinned-label drawing order rely on. A cell that is both selected and category-highlighted shows the selection ring; the highlight still reads from the dimming of the other cells.

**Decision: the region hit test reads a bucket grid; the point hit test stays a linear scan.**
*Rationale:* the band shows the number of cells it covers, so `cellsInRect` runs on every pointer move of a drag and returns up to every cell. It buckets the cells once per layout (cached in a `WeakMap`) by their top-left corner and reads only the buckets a matching cell can start in, so its cost follows the rectangle, not the grid. A bucket is one cell wide and high, and the grid never has more than four buckets per cell (64 for a tiny layout): a sparse or very large layout gets larger buckets instead of more of them, and a layout whose extent is not a finite number falls back to the scan. The property tests compare it with the scan on arbitrary cells and on computed layouts. The earlier decision not to index the point hit test stands: one hover is one scan.

**Decision: the selection bar is a row under the grid, and the layout does not know about it.**
*Alternatives:* (a) in the header, (b) a floating toolbar over the grid.
*Rationale:* in the header the bar wraps onto a second line unless the panel is wide, the grid re-fits to the smaller body, and every cell moves the moment the first one is selected, so the next Shift+click lands on another cell (seen in Grafana during development). A floating toolbar hides cells that the user may want to select. The row takes its height from the scroll container only: `computeLayout` still gets the height without the bar, so no cell moves, and the container scrolls when the bar covers its last rows. With Auto Grid fit-content the panel grows by the bar instead.

**Decision: Escape clears only with the keyboard focus inside the panel, and uses up the key press.**
*Rationale:* Escape closes many things in Grafana, and a selection is worth more than a popover, so a window-wide listener would lose it by accident. A pointer gesture moves the focus to the selection bar (a `role="group"` that is focusable by script only), so Escape works right after selecting, and Tab continues to its buttons. While a drilldown popover or link menu is open, the selection leaves Escape alone, so that one key press never clears the selection because an overlay was in the way. The key press is stopped at the panel, because Grafana would otherwise also leave the panel view or kiosk mode.

**Limitation, deliberate: cells cannot be selected with the keyboard or by touch.** The grid is one canvas without a focus model: hover and drilldown are pointer-only as well, and arrow keys scroll the container. Cell navigation with a visible cursor over tens of thousands of cells is its own feature. Touch has no Shift, and a touch drag scrolls. What a selection offers afterwards (compare, copy, clear) is plain buttons in the bar and a Grafana `Drawer`.

**Cohort comparison.** For every query the drawer compares the selected cells with all other cells of the grid. A cell's value is the one the grid shows: reduced over time and aggregated over the series in the cell.

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
*Rationale:* Grafana can change a variable at any time after a write: a refresh validates a query variable against its options again, and a viewer can pick another value. With (a) the bar went on saying `→ $name` while the variable held something else. `@grafana/runtime` has no event for "a variable changed" that exists in every supported version, so the sync polls the template service (one array read per second while a panel has a claim) and checks at once when the location changes, because Grafana mirrors variables in the URL. The outcomes are: *synced*, the variable holds what was written; *changed*, it held it and now holds something else; *rejected*, Grafana never showed the written value within two seconds.
After *changed* the variable is no longer the sync's. It is not written again until a selection changes, and it is not "restored" when the selections end, because the value in it is someone's choice. After *rejected* the original value is written back, because what Grafana made of the write is neither the selection nor what the user had.
A multi-value query variable is the case this exists for. Grafana accepts values that are not among its options, and puts the variable back to its options when it loads them again. That cannot be known before the write (the options may be loaded lazily, and a variable that loads them only once keeps the values), so the write is made and the read-back reports what happened.

**Decision: write once, 400 ms after the selection last changed, and only when the union of the claims differs from the last write.**
*Rationale:* every write re-runs the queries that use the variable. A run of Shift+clicks is one write, and `replace: true` keeps the browser history free of one entry per selection. A data refresh changes no claim, because a claim holds the label values remembered at selection time, not values read from the data. This is what ends the loop when the panel's own query uses the variable, directly or through another variable. In the first implementation the values came from the cells on screen: the write filtered the panel's data, the filtered data changed the automatically chosen label, the new values were written, and so on, 41 queries in 20 seconds. With remembered values and a configured label there is nothing for the data to change. Measured in Grafana 11.6.0, 12.4.0 and 13.3.1 with Prometheus: one query of the panel after the selection, none in the following 20 seconds.

**Decision: clearing puts back the value the variable had before the first write, if the variable still holds what was written.**
*Alternatives:* (a) always set "All", (b) an option for the cleared value, (c) leave the last selection.
*Rationale:* "All" does not exist for every variable, and an empty list cannot be written, so the previous value is the only state that is defined for every variable. If the variable was changed in between, it is left alone (see *changed* above); when a selection then changes, the write records the value of that moment as the one to put back. The same restore happens when the selection becomes too large: the `var-` parameters may add at most 6,000 URL characters, which keeps a dashboard URL under the 8 KB request line that common reverse proxies accept. The bar then says so instead of syncing a part of the selection. The same restore also runs when the panel unmounts, because the selection ends there: Grafana re-creates the panel for the panel view and the panel editor, and without it the variable would keep filtering other panels for a selection that no longer exists. It is skipped when the page path has changed since the write, so that leaving for another dashboard never writes a `var-` parameter into that dashboard's URL. A reload, or coming back with the browser's Back button, keeps the URL's value while the viewer-local selection is gone; the variable is then reset with its own picker.

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
| `selectionLabel` | hierarchy label a selection is copied and synced by (empty: chosen for the copies when a selection begins; no sync) |
| `selectionVariable` | multi-value or text box dashboard variable kept equal to the selected values of `selectionLabel` (empty: no sync) |

The **Color scale overrides** editor supports add/remove/reorder and multiple matchers per rule. It derives refId, label-name, and sample-value suggestions from both table and time-series query results while allowing custom values. Inline validation covers missing matchers or labels, invalid regex, non-finite endpoints, neither endpoint set, and `min >= max`; min-only and max-only rules are valid.

Cell selection has no option to switch it on: it does nothing until Shift is held. Its two options only say what a selection is exported as, both defaults write nothing, and the variable sync needs both.

**Decision: restrict `reduceCalc` to an allowlist of numeric reducers rather than the full standard Calculation picker.**
*Rationale:* non-numeric reducers (`allValues`, `uniqueValues`, …) produce values the color pipeline cannot render; offering them would be an invitation to a broken panel. A guarded Select with a numeric allowlist keeps the standard vocabulary while making invalid states unrepresentable.

## 11. Plugin metadata and toolchain

- id `yuuk1-fleetgrid-panel`, name `FleetGrid`, `grafanaDependency: ">=11.6.0"`.
- Scaffold: `@grafana/create-plugin@7.0.5` (pinned). **Rationale:** reproducibility of regeneration, and 7.0.5 builds against `@grafana/* ^12.x` — closer to the supported minimum (11.6) than newer scaffolds targeting 13.x, reducing the risk of accidentally depending on 13-only APIs.
- The pinned scaffold conflicts with the floating `@grafana/tsconfig@2.2.0` (`moduleResolution: "bundler"` vs. the scaffold's ts-node `module: "commonjs"` → TS5095). Fixed by overriding `moduleResolution: "nodenext"` in the ts-node block of the **root** `tsconfig.json` (mirroring upstream create-plugin 7.x), because `.config/` is tool-managed and must not be edited.
- `jest-canvas-mock` is imported from the root `jest-setup.js` **after** `.config/jest-setup` — the scaffold's setup (run in `setupFilesAfterEnv`) overwrites `getContext`, so the plan's original `setupFiles` placement produced a silently non-functional mock. Load order is the constraint; a comment in the file records it.

## 12. Testing strategy

- **Unit (Jest + jest-canvas-mock):** every pipeline stage TDD-tested as a pure function; range resolution covers refId, exact/regex, AND, order, partial endpoints, table/time-series provenance, conflict fallback, and processor reuse; renderer covers cell-specific colors as well as split regions, missing color, and contrast text.
- **Component (React Testing Library):** option editors (including range-rule add/remove/reorder, suggestions, and validation), panel wiring (multi-range legends, actual-range tooltip, selector, scroll coordinates, data-link priority, link menu, popover close paths, requery race with deferred promises).
- **E2E (`@grafana/plugin-e2e` + Playwright):** a provisioned TestData dashboard (`uid: fleetgrid-e2e`, generic zone/host/gpu data with unpadded host numbers so natural order differs from lexicographic order) exercised against the default Grafana image **and** `GRAFANA_VERSION=11.6.0`. A dedicated two-zone table panel gives equal values different maxima and verifies the legend, each tooltip range, and different canvas fills. Canvas assertions map CSS coordinates to backing-store coordinates and use locally uniform colors rather than screenshot equality, tolerating DPR and cross-version anti-aliasing differences.
- **Cell selection:** selection state, statistics, formats and variable sync are unit-tested as pure functions; fast-check properties cover the hostlist round trip against the independent expander, the regular expression (matches exactly the values), the list, Cliff's delta against the pair count of its definition, quantile bounds, and the region hit test against a scan. The gestures are tested in jsdom with a minimal `PointerEvent` (jsdom has none) and in E2E on a dedicated panel, which also checks the clipboard, the drawer and the `selected_hosts` variable in the URL. The variable sync is tested at three levels: `VariableSync` against a stand-in for Grafana that a test can make behave like Grafana or like a viewer (reset at a refresh, a write that is not kept, a change by hand); the panel with that stand-in (data refreshes, the self-filtering query, two panels, unmount); and E2E on a second dashboard (`uid: fleetgrid-selection-sync-e2e`) whose panels name a multi-value variable (two of them the same one), a text box, a single-value variable, a query variable whose options are not hosts, and a variable without a selection label, with a text panel that shows what each variable gives to a panel that uses it.
- Checks that genuinely require human eyes or a live Prometheus (visual sparkline quality, in-cell unit suffix at various widths, instant requery against a real datasource, split-region visuals, minimum-cell-size boundary) are explicitly listed as manual follow-ups rather than silently claimed.

## 13. Out of scope

Deliberately not implemented (YAGNI, confirmed during design): Conditions-style expression or threshold DSL (range matchers select only Min/Max), modifier-click actions other than the Shift selection gestures, a freeform lasso, selecting cells with the keyboard or by touch, saving a selection in the dashboard, pinned/frozen cells, zoom/pan of the grid, custom URL template mechanisms outside standard Data Links, and datasource-specific code paths (the pipeline is frame-shape-based and datasource-agnostic; Prometheus/VictoriaMetrics are the design targets, not a hard dependency).

## 14. Known limitations / future work

- Verification against a live Prometheus/VictoriaMetrics (including instant→range requery behavior) is still outstanding; README states this.
- A Shift+drag does not scroll the grid when it reaches the edge of a scrolled panel, and Shift+wheel scrolls sideways in browsers. To select beyond the visible part, scroll and drag again: drags add to the selection.
- The variable sync was verified with a real Prometheus data source on Grafana 11.6.0, 12.4.0 and 13.3.1, by scripts that are not part of CI: for multi-value custom and query variables (with and without "All", with a custom all value, refreshing on load and on time range change) and a text box, a neighbouring panel was filtered to exactly the selected hosts before and after two dashboard refreshes; for single-value custom and query variables, a constant and an interval, nothing was written and the bar said why. CI covers the same rules with TestData only.
- How a synced value reaches a query is decided by Grafana and by the data source of the panel that uses the variable. With Grafana's Prometheus data source a multi-value variable is exact for every tested value except one with a double quote or a line break, for which the other panel's query fails with an error.
- A multi-value query variable drops values that are not among its options when it loads its options again. The bar then says that the variable was changed; the sync does not prevent it.
- The hover tooltip passes on only a press with Shift. In a small panel it can still lie under the pointer and take a plain click.
