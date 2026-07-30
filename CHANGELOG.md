# Changelog

## Unreleased

- Redesign categorical decoration: replace the cycling theme palette with a fixed cool palette (blue/purple/cyan/magenta) that stays clear of the heatmap's warm magnitude colors, folding the 5th+ values into a single neutral "other" color.
- Replace the `Top bar` category style with a default `Bottom strip` (band on the cell's lower edge) and reshape `Outline` (renamed from `Border`) to frame each cell with a background gap so the color no longer bleeds into the fill. A migration rewrites the legacy `topBar` value to `Bottom strip` so provisioned dashboards keep a selected style. Decoration, highlight rings, and split-cell tiles are drawn on device-pixel boundaries so they stay crisp at any display scaling, and their thickness shrinks on small or heavily split cells so every metric tile keeps a visible sliver of fill.
- Highlight categorical cells on legend hover in addition to click, ringing matching cells in the category color for clearer double-encoding alongside the dim.

## 0.5.0 - 2026-07-24

- Add interactive categorical legend selection to highlight matching cells and dim the rest.

## 0.4.0 - 2026-07-24

- Add categorical cell decoration and a legend for label values such as Slurm partitions.

## 0.3.0 - 2026-07-24

- Add configurable extra tooltip labels, such as Slurm's `partition`, with distinct values collected across each cell.

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
