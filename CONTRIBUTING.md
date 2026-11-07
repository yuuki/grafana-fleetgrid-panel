# Contributing

Thanks for helping improve FleetGrid.

- **Bugs and ideas**: open an issue describing what you expected and what happened (plugin and
  Grafana versions, the data source and a panel JSON help). Security issues go through
  [SECURITY.md](SECURITY.md) instead.
- **Changes**: open a pull request against `main`. Keep it focused on one topic and include tests for
  behaviour changes. Use generic names in fixtures (`zone-a`, `node-a001`), never real host names.

## Before you open a pull request

```bash
npm ci
make check
```

`make check` runs the checks of the required pull request CI that work on a laptop: type check,
ESLint, Jest (unit, component and property tests), the deploy script test, the production build and
the GitHub Actions audit. It needs Node.js 26 (`.nvmrc`), Go (for actionlint) and uv or pipx (for
zizmor). Run `make help` for the other targets (E2E, property-test exploration, vulnerability
scan); [AGENTS.md](AGENTS.md) explains when each one is needed and lists the compatibility contracts
(plugin ID, panel option keys) that must not change silently.

Do not edit `.config/`: it is managed by Grafana's plugin tools.

## Commit messages

Short subjects with a type prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `ci:` or `chore:`,
followed by the reason in the body when it is not obvious. Note user-visible changes in
`CHANGELOG.md`.
