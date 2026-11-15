#!/usr/bin/env bash
# Writes a consistent copy of the account database and keeps the last 14.
# Run daily as root (cron: `17 3 * * * /opt/wizardry-accounts/backup.sh`), then
# let the existing off-site backup pick up the output directory.
#
# The pepper in /etc/wizardry-accounts/env is deliberately NOT copied here. With
# both, the hashes in the database can be tested against guesses; keep the pepper
# in a different place from these files.
set -euo pipefail

DB="${ACCOUNT_DB:-/var/lib/wizardry-accounts/accounts.db}"
OUT="${ACCOUNT_BACKUP_DIR:-/var/backups/wizardry-accounts}"
KEEP="${ACCOUNT_BACKUP_KEEP:-14}"

[ -f "$DB" ] || { echo "backup: no database at $DB" >&2; exit 1; }
install -d -m 0700 "$OUT"
target="$OUT/accounts-$(date -u +%Y%m%dT%H%M%SZ).db"

# VACUUM INTO takes a snapshot while the server keeps running; a plain cp can catch a write halfway.
DB="$DB" TARGET="$target" node --no-warnings --input-type=commonjs <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("VACUUM INTO ?").run(process.env.TARGET);
db.close();
const copy = new DatabaseSync(process.env.TARGET, { readOnly: true });
const ok = copy.prepare("PRAGMA integrity_check").get().integrity_check;
copy.close();
if (ok !== "ok") { console.error("backup: copy failed its integrity check"); process.exit(1); }
NODE
chmod 0600 "$target"
ls -1t "$OUT"/accounts-*.db | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "backup: wrote $(basename "$target") ($(stat -c %s "$target") bytes)"
