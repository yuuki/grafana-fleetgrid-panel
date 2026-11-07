# AGENTS.md

Guide for coding agents (Claude Code, Codex, Copilot) and humans working on FleetGrid, a
frontend-only Grafana **panel** plugin (`yuuk1-fleetgrid-panel`). `README.md` is the user-facing
documentation; `docs/design.md` records the design decisions and their rationale. Read both before
changing behaviour.

## Project knowledge
This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

<!-- The pointer above is the one `@grafana/create-plugin` checks for in AGENTS.md; keep it verbatim.
`.config/AGENTS/` is managed by create-plugin (updated by the cp-update workflow). This file is not,
so project knowledge lives here. -->

## 1. Overview and architecture

FleetGrid renders nested topologies (zone → host → GPU, …) as a hierarchical grid of cells colored by
a Prometheus / VictoriaMetrics metric. It targets a few thousand cells (up to ~15,000 sub-regions in
split mode), so all cells are drawn on one `<canvas>`; only the interactive pieces (tooltip, drilldown
popover, legends, metric selector, link menu) are React DOM overlays.

The panel is a pipeline of pure functions feeding a thin renderer (`docs/design.md` §2):

```
DataFrame[] → normalize (src/data/normalize.ts)   frames → NormalizedRow[] {labels, value, refId}
            → hierarchy (src/data/hierarchy.ts)   rows + LevelDef[] → tree (natural sort, warnings)
            → cells     (src/data/values.ts)      leaves ← CellModel (union of refIds, spatial aggregation)
            → display   (src/data/display.ts)     Grafana display processors per refId
            → ranges    (src/data/model.ts, rangeOverrides.ts, cellRange.ts)  label-based Min/Max
            → layout    (src/layout/layout.ts)    tree + panel size → cell rectangles
            → render    (src/render/renderer.ts)  single canvas; hitTest.ts maps pointer → cell
```

`src/components/FleetGridPanel.tsx` wires the pipeline, the overlays and the drilldown. For instant
queries the drilldown re-queries the data source as a range query (`src/drilldown/requery.ts`) and
caches the result per panel. There is no backend: no `Magefile.go`, no Go code.

## 2. Directory layout

| Path | Contents |
| --- | --- |
| `src/module.ts` | Plugin entry: panel options, migration handler, fit-content support |
| `src/plugin.json` | Plugin metadata (ID, type, `grafanaDependency`) |
| `src/types.ts` | Options and model types (`FleetGridOptions`, `LevelDef`, `CellModel`, …) |
| `src/data/` | Pure data stages: normalize, hierarchy, values, display, model, range overrides, categories |
| `src/layout/` | Layout engine (cell size search, per-level placers) |
| `src/render/` | Canvas renderer, split regions, hit testing |
| `src/components/` | Panel component and DOM overlays |
| `src/options/` | Custom option editors |
| `src/drilldown/` | Series extraction, data links, instant → range requery |
| `src/testing/` | Test-only helpers (fast-check parameters); never imported by `module.ts` |
| `tests/` | Playwright E2E (`@grafana/plugin-e2e`) |
| `provisioning/` | Dashboards and data sources for the dev server and E2E (`uid: fleetgrid-e2e`) |
| `scripts/` | `deploy-plugin-ssh.sh` and its bash test |
| `docs/design.md` | Design decisions |
| `.config/` | **Managed by `@grafana/create-plugin`** (webpack, jest, eslint, tsconfig, Docker, agent instructions). Do not edit |
| `.claude/skills/`, `.codex/skills/` | `build-plugin` / `validate-plugin` skills for Claude Code and Codex; each `SKILL.md` only imports the body from `.config/AGENTS/skills/` |
| `.github/` | Workflows (see §5) and Dependabot |

## 3. Build

Node.js 26 (`.nvmrc`, `engines` in `package.json`); npm is the package manager (`packageManager`).
The npm scripts are the source of truth; the `Makefile` adds the cross-repository target names and
the non-npm tools. `make help` lists every target.

```bash
npm ci
npm run build        # or: make build — production bundle into dist/ (webpack config from .config/)
npm run dev          # watch mode
npm run server       # local Grafana with the plugin (Docker Compose, .config/docker-compose-base.yaml)
```

Use webpack with the configuration in `.config/` (see `.config/AGENTS/instructions.md`). Extend it
from the root files (`tsconfig.json`, `jest.config.js`, `jest-setup.js`, `eslint.config.mjs`,
`.prettierrc.js`), never by editing `.config/`. Changes to `src/plugin.json` need a Grafana restart.

## 4. Test

| Command | What | Needs |
| --- | --- | --- |
| `make test` (`npm run test:ci`) | Jest: unit, component (React Testing Library) and property tests | Node only |
| `make test-fuzz` | Property tests (`*.property.test.ts`) with random seeds and `FC_NUM_RUNS` (default 2000) examples each | Node only |
| `make test-scripts` | `scripts/deploy-plugin-ssh.test.sh` with fake `npm`/`tar`/`ssh` | bash |
| `make test-integration` (`npm run e2e`) | Playwright E2E against the provisioned dashboard | A running Grafana (`npm run server`, Docker) and Chromium (`npx playwright install chromium`) |
| `npm run compat` | Levitate compatibility against the latest `@grafana/*` (the `is-compatible` workflow) | Network; runs `@grafana/levitate@latest` |

- `npm test` is Jest **watch** mode; use `npm run test:ci` or `make test` for a single run.
- Property tests use [fast-check](https://fast-check.dev/). They are deterministic by default (fixed
  seed in `src/testing/property.ts`); `FC_SEED=random` explores, `FC_SEED=<seed>` replays a reported
  failure, `FC_NUM_RUNS=<n>` sets the examples per property. Every `fc.assert` passes
  `propertyParams()`.
- Jest loads `jest-canvas-mock` from the root `jest-setup.js`, after `.config/jest-setup`; keep that
  order (`docs/design.md` §11).
- CI runs the E2E matrix from `grafana/plugin-actions/e2e-version`: up to six Grafana versions in
  the `grafanaDependency` range of `src/plugin.json`, plus the nightly image. Locally, pin a version
  with `GRAFANA_VERSION=11.6.0 npm run server`.
- There is no race detector, fuzzer or benchmark suite for TypeScript here; the property tests cover
  the input-handling invariants instead.

## 5. Static analysis and CI

| Command | What |
| --- | --- |
| `make lint` (`npm run lint`) | ESLint (`@grafana/eslint-config` via `.config/eslint.config.mjs`); deprecation warnings are allowed, errors fail |
| `make typecheck` (`npm run typecheck`) | `tsc --noEmit` |
| `make fmt` (`npm run lint:fix`) | ESLint fixes and Prettier. Prettier is not enforced in CI yet and some files are not formatted; do not mix a mass reformat into an unrelated change |
| `make lint-actions` | actionlint and zizmor (pinned versions in the `Makefile`; zizmor runs offline without `GH_TOKEN`) |
| `make vuln` | osv-scanner on `package-lock.json`; fails on findings (needs network) |
| `make complexity` | cccc ranking; `cccc.toml` holds the backstop limits |

Workflows (`.github/workflows/`): `ci.yml` (build/lint/unit tests, plugin validator, E2E matrix, report
publishing, workflow audit), `security.yml` (CodeQL `javascript-typescript`; osv-scanner SARIF
uploaded to code scanning), `is-compatible.yml` (Levitate), `bundle-stats.yml`, `complexity.yml`
(cccc + octocov), `release.yml` (tag `v*` → `grafana/plugin-actions/build-plugin`), `cp-update.yml`
(monthly create-plugin update PR using the `GH_PAT_TOKEN` secret). Every `uses:` is pinned to a
commit SHA with the tag as a comment; `grafana/plugin-actions` tags are path-prefixed (for example
`bundle-size/v1.1.1`), resolve them with `git ls-remote --tags https://github.com/grafana/plugin-actions`.

## 6. Coding conventions

- TypeScript, React function components, Emotion (`@emotion/css`) and `@grafana/ui` theme tokens; no
  hard-coded colors for chrome (the category palette in `src/data/categories.ts` is deliberate).
- Keep data, layout and hit testing pure functions with tests next to them (`*.test.ts`); keep the
  canvas render layer thin.
- Fixtures, code and commits never contain real-system names; use generic ones (`zone-a`,
  `node-a001`, `gpu`).
- Comments and docs in English; comments explain why, not what.
- Commits: short scoped subjects with a type prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `ci:`,
  `chore:`, `test:`), the reason in the body. `CHANGELOG.md` is updated for user-visible changes.

## 7. Compatibility contracts

Changing any of these silently breaks saved dashboards or installations; call it out in the PR.

- **Plugin ID and type** (`yuuk1-fleetgrid-panel`, `panel`) in `src/plugin.json`: never change.
  `grafanaDependency` (`>=11.6.0`) is the support promise in the README.
- **Panel option paths and values persisted in dashboard JSON** (`src/module.ts`, `src/types.ts`):
  `levels` (`LevelDef`: `label`, `extract` = `raw|trailingNumber|regex`, `regex`, `sort` =
  `natural|naturalDesc|none`, `layout` = `vertical|horizontal|flow|grid`, `gridColumns`,
  `showBorder`, `showLabel`), `displayMode` (`single|split`), `defaultMetric`, `showValues`,
  `tooltipLabels`, `categoryLabel`, `categoryStyle` (`strip|border`; legacy `topBar` is migrated by
  the `setMigrationHandler` in `module.ts`), `showCategoryLegend`, `missingColor`,
  `spatialAggregation` (`max|mean|min|sum`), `reduceCalc` (numeric reducers only),
  `rangeOverrides` (`refId`, `matchers[{label, operator: exact|regex, value}]`, `min`, `max`). Renames
  need a migration; dashboards saved before an option existed must keep working (defaults are
  applied at runtime, for example `displayMode ?? 'single'`).
- **Documented semantics** (README, `docs/design.md`): union of refIds per cell, missing and
  non-finite values are `null`, first-match-wins range rules, conflict fallback that never depends
  on row order, Data Links before the popover, natural sort, the 6–40 px cell size range.
- **E2E fixture** `provisioning/dashboards/fleetgrid.json` (`uid: fleetgrid-e2e`) is what `tests/`
  asserts against.
- **Release artifact**: `yuuk1-fleetgrid-panel-<version>.zip` from `release.yml`; the tag must match
  `package.json` `version`.

## 8. Concurrency and resource management

- The drilldown requery is asynchronous: a ref-held generation token guards success, failure and
  `finally` paths so a stale response cannot resurrect an old cache or error (`docs/design.md` §9).
  Keep that pattern for any new async work in the panel.
- The requery cache is per panel and is invalidated when the panel data `requestId` changes.
- Event listeners, observers and timers added by components must be removed on unmount (Jest runs
  with workers; leaks show up as "worker process has failed to exit gracefully").

## 9. Performance constraints

- No per-cell DOM: cells stay on the single canvas; DOM node count must not grow with cell count.
- The layout search scans 69 candidate sizes on purpose (nested flow layouts make "fits" non-monotonic;
  do not replace it with binary search). The placers avoid allocations in the hot pass.
- Display processors are cached by `refId + min + max`; never build one per cell in the render loop.
- Hit testing is a linear scan by design (microseconds at the target scale).
- Only `grafana-public-path` is bundled from `node_modules`; `@grafana/*`, React, Emotion, lodash and
  rxjs are Grafana-provided externals (`.config/bundler/externals.ts`). Adding a runtime dependency
  grows the bundle and needs a reason.

## 10. Before opening a pull request

```bash
make check     # typecheck, lint, test, test-scripts, build, lint-actions
```

`make check` mirrors the required PR CI except plugin signing, the plugin validator (Docker) and
E2E. Also run, when relevant:

- `make test-integration` (with `npm run server`) when touching rendering, interactions, options
  editors, `provisioning/` or `tests/`.
- `npm run compat` when touching `@grafana/*` usage or versions.
- `make test-fuzz` when touching `src/data/`, `src/layout/` or `src/render/hitTest.ts`.
- `make vuln` when changing dependencies.

## 11. Rules for AI agents

Forbidden:

- Disabling, skipping, deleting or weakening tests, lint rules or CI checks to get green (no
  `it.skip`, blanket `eslint-disable`, `|| true`, `continue-on-error`); fix the cause.
- Editing anything under `.config/` (managed by `@grafana/create-plugin`; extend from the root
  files instead) or generated output (`dist/`).
- Changing the plugin ID or type, or the compatibility contracts in §7 without calling it out.
- Adding runtime or dev dependencies without a stated reason in the PR.
- Loosening workflow permissions, unpinning actions, adding `pull_request_target`/`workflow_run`
  triggers, or exposing `GH_PAT_TOKEN`/other secrets to pull request code.
- Committing secrets, rewriting published history, force-pushing, tagging or publishing releases.

## 12. Changes that need human review (even with green CI)

- Workflows, `release.yml`, `cp-update.yml`, Dependabot, permissions and secrets.
- Code that handles dashboard JSON or query results (normalize, hierarchy regexes, range override
  matchers, data links, requery), since dashboard editors and data sources control that input.
- The compatibility contracts in §7, `src/plugin.json`, and the migration handler.
- Dependency additions or major upgrades, especially `@grafana/*` (also run `npm run compat`).
- Pull requests opened by `cp-update.yml` (they rewrite `.config/` and `package.json`).
- Large refactors of the pipeline, layout or renderer.
