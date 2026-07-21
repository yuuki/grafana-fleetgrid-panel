#!/usr/bin/env bash

set -euo pipefail

PLUGIN_ID="yuuk1-clusterview-panel"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-}"
DEPLOY_PORT="${DEPLOY_PORT:-}"
REMOTE_PLUGIN_DIR="${REMOTE_PLUGIN_DIR:-/var/lib/grafana/plugins/${PLUGIN_ID}}"
PLUGIN_OWNER="${PLUGIN_OWNER:-grafana:grafana}"
REMOTE_SUDO="${REMOTE_SUDO:-0}"
RESTART_GRAFANA="${RESTART_GRAFANA:-0}"
GRAFANA_SERVICE="${GRAFANA_SERVICE:-grafana-server}"

if [[ -z "${DEPLOY_HOST}" ]]; then
  echo "DEPLOY_HOST is required" >&2
  exit 1
fi

if [[ -n "${DEPLOY_PORT}" && ! "${DEPLOY_PORT}" =~ ^[0-9]+$ ]]; then
  echo "DEPLOY_PORT must be a number" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

SSH_TARGET="${DEPLOY_HOST}"
if [[ -n "${DEPLOY_USER}" ]]; then
  SSH_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
fi

SSH_PORT_ARGS=()
if [[ -n "${DEPLOY_PORT}" ]]; then
  SSH_PORT_ARGS=(-p "${DEPLOY_PORT}")
fi

REMOTE_PREFIX=""
if [[ "${REMOTE_SUDO}" == "1" ]]; then
  REMOTE_PREFIX="sudo"
fi

# Quote values before embedding them in the remote shell command.
quote_remote() {
  local value="${1}"
  local escaped
  escaped="$(printf '%s' "${value}" | sed "s/'/'\\\\''/g")"
  printf "'%s'" "${escaped}"
}

REMOTE_PLUGIN_DIR_Q="$(quote_remote "${REMOTE_PLUGIN_DIR}")"
PLUGIN_OWNER_Q="$(quote_remote "${PLUGIN_OWNER}")"
GRAFANA_SERVICE_Q="$(quote_remote "${GRAFANA_SERVICE}")"

npm run build

REMOTE_COMMAND="$(printf '%s\n' \
  'set -euo pipefail' \
  "${REMOTE_PREFIX} mkdir -p ${REMOTE_PLUGIN_DIR_Q}" \
  "${REMOTE_PREFIX} tar -C ${REMOTE_PLUGIN_DIR_Q} -xf -" \
  "${REMOTE_PREFIX} chown -R ${PLUGIN_OWNER_Q} ${REMOTE_PLUGIN_DIR_Q}" \
  "${REMOTE_PREFIX} chmod -R a+rX ${REMOTE_PLUGIN_DIR_Q}")"

# --no-mac-metadata: don't embed macOS xattrs in the archive.
COPYFILE_DISABLE=1 tar -C dist --no-mac-metadata -cf - . | ssh "${SSH_PORT_ARGS[@]}" "${SSH_TARGET}" "${REMOTE_COMMAND}"

if [[ "${RESTART_GRAFANA}" == "1" ]]; then
  RESTART_COMMAND="$(printf '%s\n' \
    'set -euo pipefail' \
    "${REMOTE_PREFIX} systemctl restart ${GRAFANA_SERVICE_Q}")"
  ssh "${SSH_PORT_ARGS[@]}" "${SSH_TARGET}" "${RESTART_COMMAND}"
fi

cat <<EOF
Deployed ${PLUGIN_ID} to ${SSH_TARGET}:${REMOTE_PLUGIN_DIR}

Next steps:
1. Ensure Grafana allows unsigned plugins: GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID}
2. Restart Grafana if you did not set RESTART_GRAFANA=1
EOF
