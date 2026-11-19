#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

FAKE_BIN="${TEST_DIR}/bin"
mkdir -p "${FAKE_BIN}"

printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'printf "npm cwd=%s args=%s\\n" "$PWD" "$*" >> "${DEPLOY_TEST_LOG}"' 'mkdir -p dist' 'touch dist/plugin.js' > "${FAKE_BIN}/npm"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'printf "tar args=%s\\n" "$*" >> "${DEPLOY_TEST_LOG}"' 'printf payload' > "${FAKE_BIN}/tar"
# The fake ssh answers the passwordless-sudo probe from DEPLOY_TEST_NOPASSWD,
# decodes the `bash -c '<script>'` remote command into the log, and logs the
# stdin it receives.
cat > "${FAKE_BIN}/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
remote="${*: -1}"
if [[ "${remote}" == 'sudo -n true' ]]; then
  printf 'ssh probe args=%s\n' "$*" >> "${DEPLOY_TEST_LOG}"
  [[ "${DEPLOY_TEST_NOPASSWD}" == "1" ]]
  exit
fi
printf 'ssh args=%s\n' "$*" >> "${DEPLOY_TEST_LOG}"
eval "set -- ${remote#bash -c }"
printf 'remote script:\n%s\n' "$1" >> "${DEPLOY_TEST_LOG}"
printf 'stdin=%s\n' "$(cat)" >> "${DEPLOY_TEST_LOG}"
EOF
chmod +x "${FAKE_BIN}/npm" "${FAKE_BIN}/tar" "${FAKE_BIN}/ssh"

# run_deploy <log file> <1 if sudo needs no password> [env assignments...]
run_deploy() {
  local log_file="${1}" nopasswd="${2}"
  shift 2
  (
    cd "${ROOT_DIR}"
    env PATH="${FAKE_BIN}:${PATH}" \
      DEPLOY_TEST_LOG="${log_file}" \
      DEPLOY_TEST_NOPASSWD="${nopasswd}" \
      DEPLOY_HOST="grafana.example.test" \
      DEPLOY_USER="deployer" \
      DEPLOY_PORT="2222" \
      REMOTE_PLUGIN_DIR="/srv/grafana/plugins/yuuk1-fleetgrid-panel" \
      PLUGIN_OWNER="grafana:grafana" \
      REMOTE_SUDO="1" \
      RESTART_GRAFANA="1" \
      GRAFANA_SERVICE="grafana-server" \
      "$@" \
      bash scripts/deploy-plugin-ssh.sh </dev/null >/dev/null
  )
}

assert_common() {
  local log_file="${1}"
  grep -Fq 'npm cwd='"${ROOT_DIR}"' args=run build' "${log_file}"
  grep -Fq 'tar args=-C dist --no-mac-metadata -cf - .' "${log_file}"
  grep -Fq 'ssh probe args=-p 2222 deployer@grafana.example.test sudo -n true' "${log_file}"
  grep -Fq 'ssh args=-p 2222 deployer@grafana.example.test bash -c ' "${log_file}"
  grep -Fq 'tar -C "${STAGING_DIR}" -xf -' "${log_file}"
  grep -Fq "run mkdir -p '/srv/grafana/plugins/yuuk1-fleetgrid-panel'" "${log_file}"
  grep -Fq "run cp -R \"\${STAGING_DIR}/.\" '/srv/grafana/plugins/yuuk1-fleetgrid-panel'" "${log_file}"
  grep -Fq "run chown -R 'grafana:grafana' '/srv/grafana/plugins/yuuk1-fleetgrid-panel'" "${log_file}"
  grep -Fq "run chmod -R a+rX '/srv/grafana/plugins/yuuk1-fleetgrid-panel'" "${log_file}"
  grep -Fq "run systemctl restart 'grafana-server'" "${log_file}"
}

# Passwordless sudo: no password line, sudo -n for each privileged command.
NOPASSWD_LOG="${TEST_DIR}/nopasswd.log"
run_deploy "${NOPASSWD_LOG}" 1
assert_common "${NOPASSWD_LOG}"
grep -Fq 'run() { sudo -n "$@"; }' "${NOPASSWD_LOG}"
grep -Fxq 'stdin=payload' "${NOPASSWD_LOG}"

# sudo needs a password: it travels as the first stdin line, before the archive.
PASSWORD_LOG="${TEST_DIR}/password.log"
run_deploy "${PASSWORD_LOG}" 0 DEPLOY_SUDO_PASSWORD="p'w \$x"
assert_common "${PASSWORD_LOG}"
grep -Fq 'IFS= read -r SUDO_PASSWORD' "${PASSWORD_LOG}"
grep -Fq 'sudo -S -p "" "$@"' "${PASSWORD_LOG}"
grep -Fxq "stdin=p'w \$x" "${PASSWORD_LOG}"
grep -Fxq 'payload' "${PASSWORD_LOG}"

# sudo needs a password but there is neither DEPLOY_SUDO_PASSWORD nor a terminal
# (CI has no controlling terminal; skipped when run from one).
if ! { true </dev/tty; } 2>/dev/null; then
  NO_TTY_LOG="${TEST_DIR}/no-tty.log"
  if run_deploy "${NO_TTY_LOG}" 0 2>/dev/null; then
    echo "expected the deploy to fail without a password or terminal" >&2
    exit 1
  fi
  if grep -Fq 'ssh args=' "${NO_TTY_LOG}"; then
    echo "deploy reached ssh without a password" >&2
    exit 1
  fi
fi

printf '%s\n' 'deploy-plugin-ssh.sh: pass'
