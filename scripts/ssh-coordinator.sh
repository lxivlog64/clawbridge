#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ -n "${CLAWBRIDGE_SERVICE_ENV_FILE:-}" ]; then
  if [ ! -r "$CLAWBRIDGE_SERVICE_ENV_FILE" ]; then
    echo "Luban coordinator environment file is not readable." >&2
    exit 1
  fi
  # This is a user-owned private environment file; do not place untrusted input in it.
  . "$CLAWBRIDGE_SERVICE_ENV_FILE"
fi

export CLAWBRIDGE_RUN_MODE=coordinator
exec "$script_dir/ssh-mcp.sh"
