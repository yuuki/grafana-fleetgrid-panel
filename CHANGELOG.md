# Changelog

## Unreleased

- Add cell selection: Shift+click a cell or a group label, or Shift+drag a rectangle, to select any set of cells. Selected cells are ringed, keep their selection through data refreshes and resizes, and are cleared with **Clear** or Escape. Every gesture without Shift works as before.
- Add a cohort comparison for the selected cells against all other cells: per query, the number of cells with and without a value, min, median, p95, max and Cliff's delta. Cells without a value are counted and never treated as zero.
- Add one-click copy of the selected cells' label values as a regular expression, a comma-separated list or a hostlist (`node-a[001-012]`). The label is `Selection label`, or one that the panel chooses when the selection begins. The bar warns when the regular expression needs escaping inside a quoted string.
- Add an optional sync of the selected values of `Selection label` to a multi-value or text box dashboard variable (`Sync selection to variable`), so that other panels filter by them. The bar says that the variable holds the selection only after it has read the variable back, and says why when a variable is not written. Several panels can share one variable, and it gets its previous value back when the last selection is cleared.
- Update the transitive `brace-expansion`, `postcss`, `postcss-selector-parser`, `qs`, `serialize-javascript` and `zod` dependencies to resolve their advisories.
- Override versions that `@grafana/data`, `@grafana/runtime` and `@grafana/ui` 12.4 pin, to resolve their advisories: `dompurify` 3.4.17, `immutable` 5.1.10, `moment` 2.31.0, `uuid` 11.1.1, and `react-use` 17.6.1, which moves `js-cookie` to 3.0.8. The `@grafana/*` releases that allow the fixed `dompurify` and `moment` (13.2 and later) need React 19. The plugin bundle does not change, because Grafana provides these packages at runtime.
- Record in `osv-scanner.toml` the advisories that cannot be fixed yet, with the reason for each, until 2027-02-20: `minimatch` and `glob` in the Jest toolchain, and `react-router` 6 in `@grafana/ui`.
- Fix the drilldown popover of a panel with an instant query: a click on a cell raised an exception inside Grafana and the popover showed no sparkline. The frames of the on-demand range query have no y range (`state.range`), which Grafana's `Sparkline` requires, so the popover now computes it from the values.
- Fix Escape on the drilldown popover and the link menu: it did not close them on a dashboard, because Grafana's keyboard shortcuts stop Escape before it reaches the panel, and in the panel view it made Grafana leave the panel view instead. Escape now closes an open popover or link menu first and goes no further; with nothing open, Grafana handles it as before.

## 0.4.1 - 2026-11-12

- Treat a time series whose reduced value is not finite (for example `Last (not null)` over a `+Inf` sample) as missing, as table results already were, instead of showing `Infinity` and letting it into spatial aggregation.
- Update the transitive `browserslist`, `fast-uri`, `js-yaml`, `nanoid` and `source-map-js` dependencies to resolve the high severity advisories that failed release validation. v0.4.0 was tagged but never released, so this is the first release with the 0.4.0 changes below.
- Releases are built and published by the repository's own workflow instead of `grafana/plugin-actions`' build-plugin, whose plugin validator refused the `yuuk1` prefix of the plugin ID (not a Grafana Cloud organization). The release assets keep their names (`yuuk1-fleetgrid-panel-<version>.zip` and its `.zip.sha1`), and the release is published instead of left as a draft.

## 0.4.0 - 2026-11-05

- Support Grafana Auto Grid fit-content so the panel can shrink to its grid.
- Require Node.js 26 for development and CI, and update build and test dependencies.

## 0.3.1 - 2026-07-31

- Redesign categorical decoration: replace the cycling theme palette with a fixed cool palette (blue/purple/cyan/magenta) that stays clear of the heatmap's warm magnitude colors, folding the 5th+ values into a single neutral "other" color.
- Replace the `Top bar` category style with a default `Bottom strip` (band on the cell's lower edge) and reshape `Outline` (renamed from `Border`) to frame each cell with a background gap so the color no longer bleeds into the fill. A migration rewrites the legacy `topBar` value to `Bottom strip` so provisioned dashboards keep a selected style. Decoration, highlight rings, and split-cell tiles are drawn on device-pixel boundaries so they stay crisp at any display scaling, and their thickness shrinks on small or heavily split cells so every metric tile keeps a visible sliver of fill.
- Highlight categorical cells on legend hover in addition to click, ringing matching cells in the category color for clearer double-encoding alongside the dim.

## 0.3.0 - 2026-07-27

- Add configurable extra tooltip labels, such as Slurm's `partition`, with distinct values collected across each cell.
- Add categorical cell decoration and a legend for label values such as Slurm partitions.
- Add interactive categorical legend selection to highlight matching cells and dim the rest.

## 0.2.4 - 2026-07-23

- Update the transitive `fast-uri` dependency to 3.1.4 to resolve CVE-2026-16221 and restore release validation.

## 0.2.3 - 2026-07-23

- Show the actual hierarchy label values in cell tooltips instead of normalized display labels.
- Update end-to-end tooltip assertions to cover raw hierarchy label values.

## 0.2.2 - 2026-07-23

- Add ordered label-based color-scale ranges with exact/regex matching, partial Min/Max fallback, and an editor populated from query labels.
- Show the actual applied range in tooltips, identify multi-range metrics in legends, and warn and fall back safely when aggregated source labels select conflicting rules.
- Cover table and time-series range selection in unit, component, and two-zone end-to-end fixtures, and document GPU power and bandwidth configurations.

## 0.2.1 - 2026-07-22

- Add fixed-column hierarchy grids and expose the layout choice clearly in the editor.
- Keep range and split legends visible and readable, including long names and narrow panels.
- Improve link-menu sizing and visibility at small panel widths.
- Expand coverage for layout, display, legend, editor, panel, and end-to-end behavior.

## 0.2.0 - 2026-07-21

- Keep the current top-level group label pinned while scrolling vertically.
- Improve drilldown usability in short or narrow panels, including scrolling and resize handling.
- Keep tooltips readable across Grafana themes and improve overlay positioning.
- Add SSH deployment support for copying the built plugin to a Grafana host.

## 0.1.0

Initial release.
