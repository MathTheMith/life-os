#!/bin/bash
# Nightly off-server copy of Life OS's data, run after scripts/backup.sh.
# Takes the latest local SQLite snapshot plus the uploads mirror (and the
# Tennis club's latest pg_dump, made at 03:00 by Tennis_Wesbite/scripts/
# backup.sh, which otherwise only lives on this server), encrypts them with
# age for a public key, and pushes the result to the private repo
# MathTheMith/life-os-backups. The matching private key sits in that repo only
# as backup-key.age, locked with a passphrase that never touches this server,
# so a stolen GitHub token or repo can't read anything.
# The repo keeps the last 7 archives in a single commit (history is squashed
# on every run), so it never grows past a few MB.
set -euo pipefail

SRC=/root/life-os-backups
PUBKEY=$(cat /root/life-os/secrets/offsite-backup.pub)
WORK=/root/.life-os-offsite
REPO=https://github.com/MathTheMith/life-os-backups.git
KEEP=7
TENNIS_SRC=/root/Tennis_Wesbite/backups

# Daily snapshots only (data-YYYYMMDD-HHMM.sqlite), not manual ones.
latest=$(ls -1t "$SRC"/data-[0-9]*-[0-9][0-9][0-9][0-9].sqlite | head -1)
stamp=$(basename "$latest" .sqlite | sed 's/^data-//')

if [ ! -d "$WORK/.git" ]; then
  rm -rf "$WORK"
  git clone -q "$REPO" "$WORK" 2>/dev/null || { mkdir -p "$WORK" && git -C "$WORK" init -q -b main && git -C "$WORK" remote add origin "$REPO"; }
fi
cd "$WORK"

tar -C "$SRC" -cf - "$(basename "$latest")" uploads | age -r "$PUBKEY" -o "life-os-$stamp.tar.age"

tennis_latest=$(ls -1t "$TENNIS_SRC"/tennis-*.sql 2>/dev/null | head -1 || true)
if [ -n "$tennis_latest" ]; then
  age -r "$PUBKEY" -o "$(basename "$tennis_latest").age" "$tennis_latest"
fi

# Rotation: keep only the newest $KEEP archives of each kind.
ls -1t life-os-*.tar.age | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t tennis-*.sql.age 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

cat > README.md <<'EOF'
# Life OS backups (encrypted)

Each `life-os-<date>.tar.age` holds the SQLite database and the uploads
folder, encrypted with [age](https://age-encryption.org). Each
`tennis-<date>.sql.age` is a pg_dump of the Tennis club database.

The decryption key is `backup-key.age`, itself locked with a passphrase that
only Mathéo knows. To restore:

    age -d -o life-os-backup-key.txt backup-key.age      # asks the passphrase
    age -d -i life-os-backup-key.txt life-os-<date>.tar.age | tar -xf -
    age -d -i life-os-backup-key.txt tennis-<date>.sql.age > tennis.sql
    rm life-os-backup-key.txt
EOF

# One commit holding the current files, force-pushed: old archives don't
# pile up in the git history.
git checkout -q --orphan tmp
git add -A
git -c user.name=life-os-backup -c user.email=mathvacprv@gmail.com commit -q -m "Backup $stamp"
git branch -D main >/dev/null 2>&1 || true
git branch -m main
git push -q -f origin main

echo "Offsite backup OK: life-os-$stamp.tar.age ($(ls -1 life-os-*.tar.age | wc -l) archives on GitHub)${tennis_latest:+, $(basename "$tennis_latest").age}"
