#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

FAKE_BIN="${TEST_DIR}/bin"
LOG_FILE="${TEST_DIR}/commands.log"
mkdir -p "${FAKE_BIN}"

printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'printf "npm cwd=%s args=%s\\n" "$PWD" "$*" >> "${DEPLOY_TEST_LOG}"' 'mkdir -p dist' 'touch dist/plugin.js' > "${FAKE_BIN}/npm"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'printf "tar args=%s\\n" "$*" >> "${DEPLOY_TEST_LOG}"' 'printf payload' > "${FAKE_BIN}/tar"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'printf "ssh args=%s\\n" "$*" >> "${DEPLOY_TEST_LOG}"' 'cat >/dev/null' > "${FAKE_BIN}/ssh"
chmod +x "${FAKE_BIN}/npm" "${FAKE_BIN}/tar" "${FAKE_BIN}/ssh"

(
  cd "${ROOT_DIR}"
  PATH="${FAKE_BIN}:${PATH}" \
    DEPLOY_TEST_LOG="${LOG_FILE}" \
    DEPLOY_HOST="grafana.example.test" \
    DEPLOY_USER="deployer" \
    DEPLOY_PORT="2222" \
    REMOTE_PLUGIN_DIR="/srv/grafana/plugins/yuuk1-clusterview-panel" \
    PLUGIN_OWNER="grafana:grafana" \
    REMOTE_SUDO="1" \
    RESTART_GRAFANA="1" \
    GRAFANA_SERVICE="grafana-server" \
    bash scripts/deploy-plugin-ssh.sh >/dev/null
)

grep -Fq 'npm cwd='"${ROOT_DIR}"' args=run build' "${LOG_FILE}"
grep -Fq 'tar args=-C dist --no-mac-metadata -cf - .' "${LOG_FILE}"
grep -Fq 'ssh args=-p 2222 deployer@grafana.example.test' "${LOG_FILE}"
grep -Fq "sudo mkdir -p '/srv/grafana/plugins/yuuk1-clusterview-panel'" "${LOG_FILE}"
grep -Fq "sudo chown -R 'grafana:grafana' '/srv/grafana/plugins/yuuk1-clusterview-panel'" "${LOG_FILE}"
grep -Fq "sudo chmod -R a+rX '/srv/grafana/plugins/yuuk1-clusterview-panel'" "${LOG_FILE}"
grep -Fq "sudo systemctl restart 'grafana-server'" "${LOG_FILE}"

printf '%s\n' 'deploy-plugin-ssh.sh: pass'
