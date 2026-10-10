#!/bin/bash
# Nightly off-server copy of Life OS's data, run after scripts/backup.sh.
# Takes the latest local SQLite snapshot plus the uploads mirror, encrypts
# them with age for a public key only (the private key is NOT on this server,
# so a stolen GitHub token or repo can't read anything), and pushes the
# result to the private repo MathTheMith/life-os-backups.
# The repo keeps the last 7 archives in a single commit (history is squashed
# on every run), so it never grows past a few MB.
set -euo pipefail

SRC=/root/life-os-backups
PUBKEY=$(cat /root/life-os/secrets/offsite-backup.pub)
WORK=/root/.life-os-offsite
REPO=https://github.com/MathTheMith/life-os-backups.git
KEEP=7

# Daily snapshots only (data-YYYYMMDD-HHMM.sqlite), not manual ones.
latest=$(ls -1t "$SRC"/data-[0-9]*-[0-9][0-9][0-9][0-9].sqlite | head -1)
stamp=$(basename "$latest" .sqlite | sed 's/^data-//')

if [ ! -d "$WORK/.git" ]; then
  rm -rf "$WORK"
  git clone -q "$REPO" "$WORK" 2>/dev/null || { mkdir -p "$WORK" && git -C "$WORK" init -q -b main && git -C "$WORK" remote add origin "$REPO"; }
fi
cd "$WORK"

tar -C "$SRC" -cf - "$(basename "$latest")" uploads | age -r "$PUBKEY" -o "life-os-$stamp.tar.age"

# Rotation: keep only the newest $KEEP archives.
ls -1t life-os-*.tar.age | tail -n +$((KEEP + 1)) | xargs -r rm -f

cat > README.md <<'EOF'
# Life OS backups (encrypted)

Each `life-os-<date>.tar.age` holds the SQLite database and the uploads
folder, encrypted with [age](https://age-encryption.org). The private key is
kept off the server. To restore:

    age -d -i life-os-backup-key.txt life-os-<date>.tar.age | tar -xf -
EOF

# One commit holding the current files, force-pushed: old archives don't
# pile up in the git history.
git checkout -q --orphan tmp
git add -A
git -c user.name=life-os-backup -c user.email=mathvacprv@gmail.com commit -q -m "Backup $stamp"
git branch -D main >/dev/null 2>&1 || true
git branch -m main
git push -q -f origin main

echo "Offsite backup OK: life-os-$stamp.tar.age ($(ls -1 life-os-*.tar.age | wc -l) archives on GitHub)"
