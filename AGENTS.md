# AGENTS.md

## Project knowledge
This repository contains a **Grafana plugin**. You must Read @./.config/AGENTS/instructions.md before doing changes.

## Rules
- Keep the `## Project knowledge` section above verbatim: `@grafana/create-plugin` looks for it and re-appends it when missing.
- Read `docs/design.md` before changing behaviour: it records each design decision and why (single canvas, 69-size scan, generation tokens).
- Fixtures, code and commits use generic names (`zone-a`, `node-a001`, `gpu`), never real host or cluster names.
- Prettier is not enforced and some files are unformatted: never mix a mass reformat (`make fmt`) into an unrelated change.

## Compatibility contracts
- Plugin ID and type (`src/plugin.json`): never change; its `grafanaDependency` is the support promise of README.md.
- Panel option paths and values in dashboard JSON (`src/module.ts`, `src/types.ts`): a rename needs a migration in `setMigrationHandler`.
- The panel semantics documented in README.md and `docs/design.md`; the E2E dashboard `provisioning/dashboards/fleetgrid.json` ↔ `tests/`.
- Release artifact `yuuk1-fleetgrid-panel-<version>.zip` (`release.yml`); the tag matches `version` in `package.json`.

## Before opening a pull request
- `npm ci`, then `make check`; also `make test-integration` (with `npm run server`) for rendering, interactions, option editors, `provisioning/`, `tests/`.
- `src/data/`, `src/layout/`, `src/render/hitTest.ts`: also `make test-fuzz`; `@grafana/*` usage or versions: `npm run compat`; dependencies: `make vuln`.

## Git conventions
- Branches: `<type>/<issue>-<summary>` (`<type>/<summary>` without an issue); tools' `agent/*`, `claude/*`, `copilot/*`, `dependabot/*` keep their names.
- Commits and PR titles: Conventional Commits 1.0.0, types `feat` `fix` `perf` `refactor` `test` `docs` `build` `ci` `chore` `revert`; scopes: `data`, `layout`, `render`, `drilldown`, `options`, `components`, `e2e`.
