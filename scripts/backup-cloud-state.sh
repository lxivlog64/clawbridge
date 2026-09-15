#!/usr/bin/env bash
set -euo pipefail

state_db="${1:-/var/lib/clawbridge/cloud.sqlite}"
backup_dir="${2:-/var/backups/clawbridge}"
keep_days="${CLAWBRIDGE_BACKUP_KEEP_DAYS:-14}"

[[ -f "$state_db" ]] || { echo "Cloud database not found: $state_db" >&2; exit 1; }
[[ "$keep_days" =~ ^[1-9][0-9]*$ ]] || { echo "CLAWBRIDGE_BACKUP_KEEP_DAYS must be a positive integer." >&2; exit 1; }
mkdir -p -m 700 "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/cloud-$timestamp.sqlite"

# better-sqlite3's backup API creates a consistent snapshot even while the
# cloud service has WAL mode enabled; copying *.sqlite files directly is unsafe.
node - "$state_db" "$target" <<'NODE'
const Database = require("better-sqlite3");
const [source, target] = process.argv.slice(2);
const db = new Database(source, { readonly: true });
db.backup(target).then(() => db.close()).catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE
chmod 600 "$target"
find "$backup_dir" -type f -name 'cloud-*.sqlite' -mtime +"$keep_days" -delete
echo "$target"
