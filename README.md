# ClusterView

A Grafana panel plugin that renders nested physical topologies — such as zones, hosts, and GPUs — as a hierarchical grid, and colors each cell by a Prometheus / VictoriaMetrics metric. It is designed for a bird's-eye view of large AI / HPC clusters, where hundreds of nodes and thousands of cells need to be scanned at a glance.

The panel draws every cell on a single `<canvas>` and overlays the tooltip, drilldown popover, legend, and metric selector as React DOM. Keeping the cells off the DOM is a deliberate design choice: the number of DOM nodes stays constant regardless of cell count, which avoids the per-cell React re-render and browser layout cost that a DOM-based grid would incur at the design target of a few thousand cells (up to ~15,000 sub-regions in split mode).

## Features

- **Hierarchical grid** — Define an arbitrary number of nesting levels from your query labels (e.g. `zone` → `host` → `gpu`). Each level chooses its own layout (stack, row, flow-wrap, or grid) and sort order.
- **Standard Grafana coloring** — Color scheme (continuous gradient), Thresholds, Unit, Decimals, Min/Max, and Data Links are all configured through Grafana's native **Field** and **Overrides** tabs. There is no custom color DSL; only numeric values are colored.
- **Auto-fitted cells** — Cell size is computed from the panel dimensions. Numbers are drawn only when the formatted text fits; the exact value is always available on hover.
- **Natural sort** — Numeric segments inside labels are compared as numbers (`node-a2 < node-a10`), ascending by default (descending and "data order" are also selectable).
- **Multiple metrics** — Show one metric at a time with an in-panel selector (default), or opt in to split each cell into sub-regions to compare its metrics side by side. The tooltip and popover list every metric that returned data.
- **Drilldown** — Click a cell to open a popover with a per-metric sparkline and current value. If the field has Data Links, navigation takes priority over the popover.

## Compatibility

| Requirement | Value |
| --- | --- |
| Grafana | `>= 11.6.0` |
| Data source | Prometheus / VictoriaMetrics |
| Query type | Instant (recommended) or Range |

Coloring, units, and drilldown rely on Grafana's standard field config, so any data source that produces labeled numeric series can work, but the plugin is designed for Prometheus / VictoriaMetrics. The automated end-to-end tests run against Grafana's built-in TestData data source; verification against a live Prometheus / VictoriaMetrics instance — including the instant-query drilldown re-query — is still outstanding and recommended before production use.

## Quick start

### 1. Add queries

Add one or more numeric queries. Instant queries are recommended because the panel only needs the current value, which minimizes transfer. A range query is folded to a single current value per series (see [Reduce calculation](#data)).

```promql
# Query A — one series per (zone, host, gpu)
max by (zone, host, gpu) (gpu_power_watts)

# Query B — a second metric over the same topology
max by (zone, host, gpu) (gpu_temperature_celsius)
```

Every cell is built from the **union** of all queries, so a node present in only one query still appears in the grid; cells with no sample for the displayed query are painted with the missing color.

### 2. Configure hierarchy levels

Open the panel editor and add hierarchy levels under **Hierarchy**. The editor lists the label keys found in your query results and, for each level, shows the detected group count and sample values so misconfiguration is visible immediately.

| Level | Label | Extract | Layout |
| --- | --- | --- | --- |
| 1 | `zone` | As is | Stack |
| 2 | `host` | Trailing number | Grid (columns: 20) |
| 3 | `gpu` | As is | Grid (columns: 2) |

Levels are reorderable and there is no fixed depth limit (about 8 levels is a practical maximum).

### 3. Choose a color scheme

On the **Field** tab, set a **Color scheme** such as `Green-Yellow-Red (by value)` for a continuous gradient, or configure **Thresholds** for discrete colors. Set **Unit**, **Decimals**, and **Min/Max** as needed. Per-query settings (for example a different unit for temperature) go through **Overrides → Fields with name matching a query (by refId)**.

Each query's color scale is independent: a query with no explicit Min/Max is auto-scaled to its own data range, so a power metric (600–1000 W) and a temperature metric (30–90 °C) are not flattened onto one shared scale.

## Options reference

### Hierarchy

Configured through the **Hierarchy levels** editor. Each level has:

| Setting | Values | Notes |
| --- | --- | --- |
| Label | any detected label key | The label to group by at this level |
| Extract | `As is` / `Trailing number` / `Custom regex` | How to derive the level key from the label value. `Trailing number` turns `node-a004` into `004`; `Custom regex` uses the first capture group (e.g. `node-.+(\d\d\d)`) |
| Sort | `Natural (asc)` / `Natural (desc)` / `None` | `None` keeps data appearance order |
| Layout | `Stack` / `Row` / `Flow` / `Grid` | Grid requires a column count |
| Grid columns | number | Only for the grid layout |
| Border | on / off | Draw a border around each group |
| Group label | on / off | Show the group label |

### Display

| Option | Default | Description |
| --- | --- | --- |
| Display mode | `Single` | `Single` shows one metric with a selector; `Split` divides each cell into per-query sub-regions |
| Default metric (refId) | first query | Which query the selector starts on in single mode |
| Show values | on | Draw numbers when they fit; hover still shows the value when off or when text does not fit |
| Missing color | `rgb(70,70,70)` | Fill for cells with no sample for the displayed query |

### Data

| Option | Default | Description |
| --- | --- | --- |
| Spatial aggregation | `Max` | Combines multiple series that fall on the same cell (e.g. when the hierarchy stops above the series granularity). `Max` / `Mean` / `Min` / `Sum` |
| Reduce calculation | `Last (not null)` | Folds a range query into one current value per series. Limited to reducers that return a number |

## Multiple metrics

The cell model holds each query's value for a cell (marked missing where a query returned no series); only the drawing mode changes.

- **Single mode (default)** — Each cell is filled with the color of the selected metric. A selector at the top of the panel switches metrics with one click. The selector lists every query, including one that returned no series (shown by its refId); selecting a query with no data paints every cell with the missing color. The selection is viewer-local state and is not saved as a dashboard change; the initial metric is the **Default metric** option (or the first query).
- **Split mode (opt-in)** — Each cell is auto-divided by the number of metrics that returned data: 2 = left/right, 3 = three columns, 4 = 2×2, 5–6 = 3×2, 7–9 = 3×3. Regions are capped at 9; with 10+ metrics only the first 9 are drawn and the legend notes the remainder. A legend at the top maps each region position to its query; a query that returned no series gets no region. Values are not drawn inside split regions because they are inherently too small to read.

The tooltip (on hover) and the drilldown popover list every metric that returned data, regardless of mode.

## Drilldown

Clicking a cell resolves in this order:

1. **Data Links** — If the field has Grafana Data Links configured, the click navigates. A single link is followed immediately; multiple links open a small link-selection menu the panel renders itself. Data Links always take priority.
2. **Popover** — Otherwise a card-style popover opens next to the cell, showing the hierarchy path and, per metric, a sparkline plus the current value. It auto-flips to stay inside the panel and closes on outside-click or `Esc`.

**Instant query note** — When the panel's queries are instant (no time series in the received frames), clicking re-runs the panel's queries as range over the dashboard time range via the data source, capped at ~100 data points, then extracts the series matching the clicked cell. The result is cached per panel until the next data update, so opening additional cells does not trigger another fetch. When the panel already runs range queries, no re-query happens. If re-querying feels slow at your scale, switch to range queries to remove it entirely.

## Layout notes

Cell size is auto-fitted between **6 px** and **40 px** by scanning candidate sizes from large to small and taking the largest that fits the panel. If cells would fall below 6 px, the size is pinned to 6 px and the panel scrolls vertically; while scrolling, the current top-most level's group label stays pinned to the top. If the content is still wider than the panel, it scrolls horizontally as well.

## Development

**Prerequisites:** Node.js `>= 22` (see `.nvmrc`) and Docker (for `npm run server` and the e2e Grafana instance). Before the first `npm run e2e`, install the Playwright browser once with `npx playwright install chromium`.

```bash
npm install

# Build in watch mode
npm run dev

# Production build
npm run build

# Type check and lint
npm run typecheck
npm run lint

# Unit tests (Jest)
npm run test:ci

# Run a local Grafana with the plugin (Docker)
npm run server

# Pin a Grafana version for the dev server / e2e
GRAFANA_VERSION=11.6.0 npm run server

# End-to-end tests (Playwright, @grafana/plugin-e2e) — needs a running server
npm run e2e
```

The build uses the webpack configuration provided in `.config/`. Data transformation (`src/data`), layout (`src/layout`), and hit testing (`src/render`) are pure functions verified directly with Jest; the canvas render layer is intentionally thin.

## Screenshots

<!-- Add screenshots under src/img/ and reference them here, and register them in
     plugin.json (info.screenshots) before publishing to the Grafana catalog. -->

_Screenshots are not yet included. Add them under `src/img/` and list them in `plugin.json` before publishing._

## License

Apache-2.0. See [LICENSE](./LICENSE).
