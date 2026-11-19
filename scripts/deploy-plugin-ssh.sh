#!/usr/bin/env bash

set -euo pipefail

PLUGIN_ID="yuuk1-fleetgrid-panel"
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

# The remote command's stdin carries the plugin archive, so sudo cannot prompt
# there. When sudo needs a password, ask for it here (or take it from
# DEPLOY_SUDO_PASSWORD) and send it as the first line of stdin; the remote side
# reads that line and feeds it to `sudo -S` for each privileged command.
SUDO_PASSWORD_NEEDED=0
if [[ "${REMOTE_SUDO}" == "1" ]]; then
  if ! ssh "${SSH_PORT_ARGS[@]}" "${SSH_TARGET}" 'sudo -n true' </dev/null 2>/dev/null; then
    SUDO_PASSWORD_NEEDED=1
    if [[ -z "${DEPLOY_SUDO_PASSWORD:-}" ]]; then
      if ! { true </dev/tty; } 2>/dev/null; then
        echo "sudo on ${SSH_TARGET} needs a password: set DEPLOY_SUDO_PASSWORD or run from a terminal" >&2
        exit 1
      fi
      IFS= read -rs -p "[sudo] password for ${SSH_TARGET}: " DEPLOY_SUDO_PASSWORD </dev/tty
      echo >&2
    fi
  fi
fi

npm run build

REMOTE_LINES=('set -euo pipefail')
if [[ "${REMOTE_SUDO}" != "1" ]]; then
  REMOTE_LINES+=('run() { "$@"; }')
elif [[ "${SUDO_PASSWORD_NEEDED}" == "1" ]]; then
  REMOTE_LINES+=(
    'IFS= read -r SUDO_PASSWORD'
    'run() { printf "%s\n" "${SUDO_PASSWORD}" | sudo -S -p "" "$@"; }'
    'run true || { echo "sudo authentication failed" >&2; exit 1; }'
  )
else
  REMOTE_LINES+=('run() { sudo -n "$@"; }')
fi
# The archive is extracted into a staging directory as the SSH user and then
# copied into place with sudo, so the password line and the archive can share
# stdin without sudo consuming part of the archive.
REMOTE_LINES+=(
  'STAGING_DIR="$(mktemp -d)"'
  'trap '\''rm -rf "${STAGING_DIR}"'\'' EXIT'
  'tar -C "${STAGING_DIR}" -xf -'
  "run mkdir -p ${REMOTE_PLUGIN_DIR_Q}"
  "run cp -R \"\${STAGING_DIR}/.\" ${REMOTE_PLUGIN_DIR_Q}"
  "run chown -R ${PLUGIN_OWNER_Q} ${REMOTE_PLUGIN_DIR_Q}"
  "run chmod -R a+rX ${REMOTE_PLUGIN_DIR_Q}"
)
if [[ "${RESTART_GRAFANA}" == "1" ]]; then
  REMOTE_LINES+=("run systemctl restart ${GRAFANA_SERVICE_Q}")
fi
REMOTE_COMMAND="$(printf '%s\n' "${REMOTE_LINES[@]}")"

# --no-mac-metadata: don't embed macOS xattrs in the archive.
{
  if [[ "${SUDO_PASSWORD_NEEDED}" == "1" ]]; then
    printf '%s\n' "${DEPLOY_SUDO_PASSWORD}"
  fi
  COPYFILE_DISABLE=1 tar -C dist --no-mac-metadata -cf - .
} | ssh "${SSH_PORT_ARGS[@]}" "${SSH_TARGET}" "bash -c $(quote_remote "${REMOTE_COMMAND}")"

cat <<EOF
Deployed ${PLUGIN_ID} to ${SSH_TARGET}:${REMOTE_PLUGIN_DIR}

Next steps:
1. Ensure Grafana allows unsigned plugins: GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID}
2. Restart Grafana if you did not set RESTART_GRAFANA=1
EOF
