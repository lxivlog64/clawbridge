#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

backup_file="${1:?Usage: verify-cloud-backup.sh /path/to/cloud-YYYY.sqlite}"
[[ -f "$backup_file" ]] || { echo "Backup not found: $backup_file" >&2; exit 1; }
node - "$backup_file" <<'NODE'
const Database = require("better-sqlite3");
const db = new Database(process.argv[2], { readonly: true });
const integrity = db.pragma("integrity_check", { simple: true });
const expected = ["cloud_task_events", "cloud_task_reviews", "cloud_tasks", "cloud_workers"];
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cloud_tasks','cloud_workers','cloud_task_events','cloud_task_reviews') ORDER BY name").all().map((x) => x.name);
db.close();
if (integrity !== "ok" || JSON.stringify(tables) !== JSON.stringify(expected)) process.exit(1);
console.log(JSON.stringify({ integrity, tables }));
NODE
