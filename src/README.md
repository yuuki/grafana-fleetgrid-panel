# FleetGrid

FleetGrid is a Grafana panel plugin that renders nested physical topologies — such as zones, hosts, and GPUs — as a hierarchical grid, and colors each cell by a Prometheus / VictoriaMetrics metric. It is built for a bird's-eye view of large AI / HPC clusters, where hundreds of nodes and thousands of cells need to be scanned at a glance.

All cells are drawn on a single `<canvas>`, with the tooltip, drilldown popover, legend, and metric selector overlaid as React DOM. Keeping the cells off the DOM keeps the node count constant regardless of cell count, which is what makes the design target of a few thousand cells (up to ~15,000 sub-regions in split mode) practical.

## Features

- **Hierarchical grid** — Define an arbitrary number of nesting levels from your query labels (for example `zone` → `host` → `gpu`). Each level chooses its own layout (stack, row, flow-wrap, or grid) and sort order, with an editor that lists the detected label keys and previews the group count.
- **Standard Grafana coloring** — Color scheme (continuous gradient), Thresholds, Unit, Decimals, Min/Max, and Data Links are all configured through Grafana's native Field and Overrides tabs. There is no custom color DSL; only numeric values are colored, and each query keeps its own color scale.
- **Auto-fitted cells** — Cell size is computed from the panel dimensions. Numbers are drawn only when the formatted text fits; the exact value is always available on hover.
- **Natural sort** — Numeric segments inside labels are compared as numbers (`node-a2` before `node-a10`), ascending by default (descending and data-order are also selectable).
- **Multiple metrics** — Show one metric at a time with an in-panel selector (default), or opt in to split each cell into sub-regions to compare its metrics side by side. The tooltip and popover list every metric that returned data.
- **Drilldown** — Click a cell to open a popover with the current value per metric, plus a sparkline whenever time-series data is available for that metric. If the field has Data Links, navigation takes priority over the popover.

## Requirements

- Grafana `>= 11.6.0`.
- A Prometheus / VictoriaMetrics data source. Any data source that returns labeled numeric series can work, because coloring and units rely on Grafana's standard field config, but the plugin is designed for Prometheus / VictoriaMetrics.
- Instant queries are recommended (only the current value is needed); range queries are folded to one current value per series.

The automated end-to-end tests run against Grafana's built-in TestData data source. Verification against a live Prometheus / VictoriaMetrics instance — including the instant-query drilldown re-query (which re-issues instant queries as range, converting any `format: table` query to `time_series`) — is still outstanding and recommended before production use.

## Getting started

1. Add one or more numeric queries whose series carry the labels you want to nest (for example `zone`, `host`, `gpu`).
2. In the panel editor, under **Hierarchy**, add a level per label. For each level pick how to extract the key (as-is, trailing number, or a custom regex), the sort order, and the layout.
3. On the **Field** tab, choose a **Color scheme** such as `Green-Yellow-Red (by value)` for a continuous gradient, or configure **Thresholds** for discrete colors. Set **Unit**, **Decimals**, and **Min/Max** as needed; use **Overrides** (by refId) for per-query settings.

Cells are built from the union of all queries, so a node present in only one query still appears; cells with no sample for the displayed query use the missing color. To compare several metrics side by side, enable split mode under **Display**; it shows the queries that returned data, capped at the first nine.

## Source and documentation

Source code, the full options reference, and the development guide are on GitHub:
[github.com/yuuki/grafana-clusterview-panel](https://github.com/yuuki/grafana-clusterview-panel).

## License

Licensed under the Apache License 2.0.
