# Security policy

FleetGrid is a frontend-only Grafana panel plugin: it runs in the browser of every dashboard viewer,
renders query results from Grafana data sources, and evaluates panel options that dashboard editors
save (hierarchy extraction regexes, label-based range rules, Data Links). Issues that let crafted
query results, labels or saved panel options run script in a viewer's browser (XSS), leak data across
panels or data sources, or make the panel issue requests other than the documented drilldown
re-query are treated as vulnerabilities. So are weaknesses in how the release archive is built.

Out of scope: the Docker Compose development stack and its anonymous admin access, denial of service
by a dashboard editor who saves an expensive regular expression (editors are trusted to configure
panels), and the security of Grafana, its data sources or Prometheus / VictoriaMetrics themselves
(please report those upstream).

## Supported versions

Security fixes are made on the `main` branch and released in the next version. Only the latest
release is supported.

## Reporting a vulnerability

Please do **not** open a public issue, pull request or discussion.

Report the vulnerability privately with GitHub's
[private vulnerability reporting](https://github.com/yuuki/grafana-fleetgrid-panel/security/advisories/new)
(the "Report a vulnerability" button of the Security tab). If that is not possible, contact the
author privately via the contact information on https://github.com/yuuki.

Please include the plugin version, the Grafana version, the panel JSON or query result that triggers
the issue (with real host names and secrets removed), what an attacker controls (a dashboard, a data
source, metric labels, ...), and the impact. You should receive an answer within a few weeks; the
plugin is maintained on a best-effort basis.
