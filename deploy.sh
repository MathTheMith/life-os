#!/bin/bash
# Rebuild and redeploy Life OS on this server (backend container + static
# frontend). Keeps a copy of the previous frontend in /root/life-os-www-backup.
set -euo pipefail
cd /root/life-os

rm -rf /root/life-os-www-backup
cp -a /var/www/life-os /root/life-os-www-backup

docker compose build backend
docker compose up -d backend

docker build -t life-os-frontend-build ./frontend
docker rm -f tmp-extract 2>/dev/null || true
docker create --name tmp-extract life-os-frontend-build
rm -rf /var/www/life-os/*
docker cp tmp-extract:/app/dist/. /var/www/life-os/
docker rm tmp-extract
chown -R www-data:www-data /var/www/life-os

echo "Life OS deployed."
