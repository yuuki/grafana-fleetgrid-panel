# AGENTS.md

Rules for coding agents (and humans) that the code does not show.
[docs/design.md](docs/design.md) is the source of truth for design decisions;
read it before changing behaviour.

## Project knowledge
This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

<!-- `@grafana/create-plugin` checks AGENTS.md for the pointer above: keep it verbatim. -->

## Rules the code does not show

- English only. Use Grafana's official plugin docs
  (https://grafana.com/developers/plugin-tools/): training data is outdated.
- Extend webpack, Jest, ESLint, TypeScript and Prettier from the root config
  files, never by editing `.config/` (`@grafana/create-plugin` manages it and
  `cp-update.yml` rewrites it).
- Fixtures, code and commits use generic names (`zone-a`, `node-a001`, `gpu`),
  never real host or cluster names.
- Cells stay on the single `<canvas>`: no per-cell DOM nodes.
- The layout search scans its 69 candidate sizes on purpose (nested flow
  layouts make "fits" non-monotonic): do not turn it into a binary search.
- Display processors are cached by `refId` + min + max: never build one per
  cell in the render loop. Hit testing is a linear scan by design.
- Async work in the panel follows the drilldown requery pattern: a ref-held
  generation token guards the success, failure and `finally` paths, so a
  stale response cannot resurrect an old cache or error.
- Chrome uses `@grafana/ui` theme tokens, no hard-coded colors (the category
  palette in `src/data/categories.ts` is the deliberate exception).
- Every `fc.assert` passes `propertyParams()` (deterministic in CI);
  production code never imports `src/testing/`.
- Prettier is not enforced yet and some files are unformatted: do not mix a
  mass reformat into an unrelated change.
- User-visible changes get a `CHANGELOG.md` entry.

## Compatibility contracts

- Plugin ID and type (`src/plugin.json`): never change. Its
  `grafanaDependency` is the support promise of README.md.
- Panel option paths and values persisted in dashboard JSON (`src/module.ts`,
  `src/types.ts`): a rename needs a migration in the `setMigrationHandler` of
  `src/module.ts`, and dashboards saved before an option existed keep working
  (defaults applied at runtime).
- The panel semantics documented in README.md and `docs/design.md`.
- The E2E dashboard `provisioning/dashboards/fleetgrid.json` and `tests/`
  change together.
- Release artifact `yuuk1-fleetgrid-panel-<version>.zip` (`release.yml`); the
  tag matches `version` in `package.json`.

## Before opening a pull request

`npm ci`, then `make check`. Also, when you touch:

- rendering, interactions, option editors, `provisioning/` or `tests/`:
  `make test-integration` (with `npm run server`);
- `src/data/`, `src/layout/` or `src/render/hitTest.ts`: `make test-fuzz`;
- `@grafana/*` usage or versions: `npm run compat`;
- dependencies: `make vuln`;
- `src/plugin.json`: restart Grafana (it reads it only at start); say so in
  the PR.

## Git conventions

Branches: `<type>/<issue>-<summary>`, or `<type>/<summary>` without an issue
(`fix/166-connect-errors`, `feat/qp-counters`). `<type>` is a commit type
below; `<summary>` is 2–5 lowercase ASCII words joined by `-`. Branches named
by tools keep their names (`agent/*`, `claude/*`, `copilot/*`,
`dependabot/*`). Never push to the default branch.

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

    <type>(<scope>)!: <subject>

    <body>

    <footer>

- `type`: `feat` (new user-visible behaviour), `fix` (bug fix), `perf`,
  `refactor` (no behaviour change), `test`, `docs`, `build` (build system,
  dependencies, packaging), `ci` (workflows), `chore` (anything else, e.g.
  `chore(release): prepare v1.2.3`), `revert`.
- `scope`: optional; the package or area changed: `data`, `layout`,
  `render`, `drilldown`, `options`, `components`, `e2e`.
- `!` and a `BREAKING CHANGE: <what changed and how to migrate>` footer for
  any change to a compatibility contract above.
- `subject`: imperative, lower case (except identifiers), no final period,
  at most 72 characters including the prefix.
- `body`: why the change is needed and what it affects, wrapped at 72
  columns; required unless the subject says everything.
- `footer`: `Fixes #N` / `Refs #N`, `BREAKING CHANGE:`, trailers such as
  `Co-Authored-By:`.
- One logical change per commit; regenerated files go in the commit that
  changes their source. Pull request titles use the same format (they become
  the squash commit).

## Forbidden

- Disabling, skipping, deleting or weakening tests, lint rules or CI checks
  to get green (`it.skip`, blanket `eslint-disable`, `|| true`,
  `continue-on-error`).
- Editing `.config/` or generated output (`dist/`).
- Changing a compatibility contract without calling it out.
- Adding runtime or dev dependencies without a reason in the PR (a runtime
  dependency grows the bundle).
- Loosening workflow permissions, unpinning actions, adding
  `pull_request_target`/`workflow_run` triggers, or exposing `GH_PAT_TOKEN`
  or other secrets to pull request code.
- Committing secrets, rewriting published history, force-pushing, tagging or
  publishing releases.

## Needs human review

Even with green CI: workflows, Dependabot, permissions and secrets; pull
requests opened by `cp-update.yml`; code handling dashboard JSON or query
results (normalize, hierarchy regexes, range override matchers, data links,
requery); `src/plugin.json`, the migration handler and the other contracts;
dependency additions or major upgrades; large refactors of the pipeline,
layout or renderer.

## Environment notes

- `grafana/plugin-actions` tags are path-prefixed (`bundle-size/v1.1.1`);
  resolve a pin with `git ls-remote --tags https://github.com/grafana/plugin-actions`.
