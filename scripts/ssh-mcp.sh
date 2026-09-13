#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
bridge_dir="$(dirname -- "$script_dir")"
ssh_host="${CLAWBRIDGE_SSH_HOST:-codebuddy-worker}"
local_port="${CLAWBRIDGE_LOCAL_PORT:-18080}"
remote_port="${CLAWBRIDGE_REMOTE_PORT:-8080}"
remote_codebuddy="${CLAWBRIDGE_REMOTE_CODEBUDDY:-codebuddy}"
tunnel_dir="${TMPDIR:-/tmp}/clawbridge-${UID}"
control_socket="${tunnel_dir}/ssh-control"

mkdir -p "$tunnel_dir"
chmod 700 "$tunnel_dir"

if ! ssh -S "$control_socket" -O check "$ssh_host" >/dev/null 2>&1; then
  if [ -e "$control_socket" ]; then
    mv "$control_socket" "${control_socket}.stale.$(date +%s)"
  fi
  ssh \
    -M \
    -S "$control_socket" \
    -o ControlPersist=600 \
    -o ExitOnForwardFailure=yes \
    -fN \
    -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" \
    "$ssh_host"
fi

codebuddy_gateway_token="$(ssh "$ssh_host" "$remote_codebuddy config get gateway.password" | tr -d '\r\n')"
if [ -z "$codebuddy_gateway_token" ]; then
  echo "CodeBuddy Gateway password is missing on the remote worker." >&2
  exit 1
fi

export CODEBUDDY_BASE_URL="http://127.0.0.1:${local_port}/api/v1"
export CODEBUDDY_GATEWAY_TOKEN="$codebuddy_gateway_token"

exec node "$bridge_dir/dist/src/server.js"
