#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
bridge_dir="$(dirname -- "$script_dir")"
ssh_host="${CLAWBRIDGE_SSH_HOST:-codebuddy-worker}"
local_port="${CLAWBRIDGE_LOCAL_PORT:-18080}"
remote_port="${CLAWBRIDGE_REMOTE_PORT:-8080}"
remote_codebuddy="${CLAWBRIDGE_REMOTE_CODEBUDDY:-codebuddy}"
ssh_port="${CLAWBRIDGE_SSH_PORT:-22}"
user_id="$(id -u)"
case "$local_port:$remote_port:$ssh_port" in
  *[!0-9:]*|:*|*::*|*:) echo "ClawBridge ports must be numeric." >&2; exit 1 ;;
esac
instance_material="${CLAWBRIDGE_INSTANCE:-${ssh_host}-${ssh_port}-${local_port}-${remote_port}}"
instance_key="$(printf '%s' "$instance_material" | cksum | awk '{print $1}')"
tunnel_dir="${TMPDIR:-/tmp}/clawbridge-${user_id}-${instance_key}"
control_socket="${tunnel_dir}/ssh-control"
lock_dir="${tunnel_dir}/startup.lock"

mkdir -p "$tunnel_dir"
chmod 700 "$tunnel_dir"

attempt=0
while ! mkdir "$lock_dir" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    echo "Timed out waiting for another ClawBridge startup." >&2
    exit 1
  fi
  sleep 1
done
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT HUP INT TERM

if ! ssh -n -p "$ssh_port" -S "$control_socket" -O check "$ssh_host" >/dev/null 2>&1; then
  if [ -e "$control_socket" ]; then
    mv "$control_socket" "${control_socket}.stale.$(date +%s)"
  fi
  ssh \
    -n \
    -M \
    -S "$control_socket" \
    -p "$ssh_port" \
    -o BatchMode=yes \
    -o ConnectTimeout=15 \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ControlPersist=600 \
    -o ExitOnForwardFailure=yes \
    -fN \
    -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" \
    "$ssh_host"
fi

codebuddy_gateway_token="$(ssh -n -p "$ssh_port" -o BatchMode=yes -o ConnectTimeout=15 "$ssh_host" "$remote_codebuddy config get gateway.password" | tr -d '\r\n')"
if [ -z "$codebuddy_gateway_token" ]; then
  echo "CodeBuddy Gateway password is missing on the remote worker." >&2
  exit 1
fi

export CODEBUDDY_BASE_URL="http://127.0.0.1:${local_port}/api/v1"
export CODEBUDDY_GATEWAY_TOKEN="$codebuddy_gateway_token"

rmdir "$lock_dir" 2>/dev/null || true
trap - EXIT HUP INT TERM
exec node "$bridge_dir/dist/src/server.js"
