# Thin entry points shared with the maintainer's other repositories. The work
# itself stays in the package.json scripts (Grafana plugin tooling, CI and the
# .config/AGENTS skills call those directly); this file only adds the
# cross-repository target names and the tools that are not npm packages
# (actionlint, zizmor, osv-scanner) at pinned versions. `make help` lists the
# targets; AGENTS.md says which one to run when.

# Tool versions. CI pins the same versions (.github/workflows); bump together.
ACTIONLINT_VERSION      ?= v1.7.12
ZIZMOR_VERSION          ?= 1.32.0
GH_ACTIONS_LOCK_VERSION ?= v0.4.1
OSV_SCANNER_VERSION     ?= v2.7.0
# Examples per property for test-fuzz (the deterministic default is in src/testing/property.ts).
FC_NUM_RUNS             ?= 2000

NPM ?= npm
# actionlint and osv-scanner run through `go run`, which verifies the module checksums.
ACTIONLINT  ?= go run github.com/rhysd/actionlint/cmd/actionlint@$(ACTIONLINT_VERSION)
OSV_SCANNER ?= go run github.com/google/osv-scanner/v2/cmd/osv-scanner@$(OSV_SCANNER_VERSION)
# uvx or pipx (preinstalled on GitHub-hosted runners) runs the pinned zizmor.
ZIZMOR      ?= $(if $(shell command -v uvx 2>/dev/null),uvx zizmor@$(ZIZMOR_VERSION),pipx run zizmor==$(ZIZMOR_VERSION))
# gh-actions-lock (the `gh actions-lock` extension) runs through `go run` too.
GH_ACTIONS_LOCK ?= go run github.com/github/gh-actions-lock/cmd/gh-actions-lock@$(GH_ACTIONS_LOCK_VERSION)

# `npm ci` writes this file, so dependencies are reinstalled only when the lockfile changes.
NODE_MODULES := node_modules/.package-lock.json

.DEFAULT_GOAL := help
.PHONY: help check build lint fmt typecheck test test-fuzz test-scripts test-integration lint-actions lock-actions vuln vuln-sarif complexity

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  %-17s %s\n", $$1, $$2}'

check: typecheck lint test test-scripts build lint-actions ## Local pre-PR gate: the PR CI build job (minus signing, validator, E2E) and the workflow audit

build: $(NODE_MODULES) ## Production bundle into dist/ (webpack, npm run build)
	$(NPM) run build

lint: $(NODE_MODULES) ## ESLint (npm run lint)
	$(NPM) run lint

fmt: $(NODE_MODULES) ## Apply ESLint fixes and Prettier (npm run lint:fix)
	$(NPM) run lint:fix

typecheck: $(NODE_MODULES) ## TypeScript type check (npm run typecheck)
	$(NPM) run typecheck

test: $(NODE_MODULES) ## Unit, component and property tests (Jest, npm run test:ci)
	$(NPM) run test:ci

test-fuzz: $(NODE_MODULES) ## Property tests with fresh random seeds (FC_NUM_RUNS examples per property)
	FC_SEED=random FC_NUM_RUNS=$(FC_NUM_RUNS) npx jest --ci --testPathPatterns '\.property\.test\.'

test-scripts: ## Tests for scripts/ (bash with fake npm, tar and ssh)
	bash scripts/deploy-plugin-ssh.test.sh

test-integration: $(NODE_MODULES) ## Playwright E2E (npm run e2e); needs a running Grafana (npm run server) and Chromium
	$(NPM) run e2e

# zizmor runs its online audits only with a GitHub token (CI passes one); `make
# lint-actions GH_TOKEN=` forces offline mode where GitHub's API is unreachable.
# gh-actions-lock checks that .github/workflows/actions.lock pins every
# action the workflows use; with GH_TOKEN it also verifies each pin upstream.
lint-actions: ## Lint (actionlint) and audit (zizmor) the GitHub Actions workflows, and check their lockfile
	$(ACTIONLINT)
	$(if $(GH_TOKEN),$(ZIZMOR),env -u GH_TOKEN $(ZIZMOR) --offline) .
	$(GH_ACTIONS_LOCK) $(if $(GH_TOKEN),--verify,--verify-local)

# Pin the actions in .github/workflows/actions.lock after a `uses:` changed,
# then review the diff. Needs a GitHub token (GH_TOKEN or `gh auth login`).
lock-actions: ## Update .github/workflows/actions.lock after changing a uses: line
	$(GH_ACTIONS_LOCK)

vuln: ## Known vulnerabilities in package-lock.json (osv-scanner; needs network; fails on findings)
	$(OSV_SCANNER) scan source --lockfile package-lock.json

# CI uploads this SARIF file to code scanning, which tracks known findings as
# alerts and flags only the ones a pull request introduces. osv-scanner exits
# 1 when it finds vulnerabilities; any other non-zero status is an error. `go
# run` reports every failure as status 1, so a scan (or tool build) that
# failed is recognised by the missing report instead.
vuln-sarif: ## osv-scanner results as SARIF in osv-scanner.sarif (fails only on scanner errors)
	@rm -f osv-scanner.sarif; status=0; \
		$(OSV_SCANNER) scan source --lockfile package-lock.json --format=sarif --output-file=osv-scanner.sarif || status=$$?; \
		if [ $$status -ne 0 ] && [ $$status -ne 1 ]; then exit $$status; fi; \
		test -s osv-scanner.sarif || { echo 'vuln-sarif: osv-scanner wrote no report' >&2; exit 1; }

complexity: ## Cognitive / Cyclomatic complexity ranking (needs cccc; thresholds in cccc.toml)
	cccc --table src

$(NODE_MODULES): package-lock.json
	$(NPM) ci
