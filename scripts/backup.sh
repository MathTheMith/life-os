#!/bin/bash
# Daily backup of life-os's data: a consistent SQLite snapshot (safe even
# with WAL mode live, via better-sqlite3's own .backup()) plus a mirror of
# the uploads directory (chat images). Kept outside both the docker volume
# and /var/www, so losing either doesn't take the backups down too.
set -euo pipefail

DEST=/root/life-os-backups
STAMP=$(date +%Y%m%d-%H%M)
TMP_IN_CONTAINER=/app/data/backup-tmp.sqlite

mkdir -p "$DEST"

docker exec life-os-backend-1 node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/data.sqlite', { readonly: true });
db.backup('$TMP_IN_CONTAINER').then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
"
docker cp life-os-backend-1:$TMP_IN_CONTAINER "$DEST/data-$STAMP.sqlite"
docker exec life-os-backend-1 rm -f "$TMP_IN_CONTAINER"

# Uploads aren't versioned per day (images don't change once written) —
# just kept as one up-to-date mirror, not duplicated daily.
rm -rf "$DEST/uploads.tmp"
docker cp life-os-backend-1:/app/data/uploads "$DEST/uploads.tmp" 2>/dev/null || mkdir -p "$DEST/uploads.tmp"
rm -rf "$DEST/uploads"
mv "$DEST/uploads.tmp" "$DEST/uploads"

# Rotation: keep 14 days of SQLite snapshots.
find "$DEST" -maxdepth 1 -name 'data-*.sqlite' -mtime +14 -delete

echo "Backup OK: $DEST/data-$STAMP.sqlite"
