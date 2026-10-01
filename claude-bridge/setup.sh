#!/bin/bash
set -euo pipefail

echo "== 1/3 : docker compose up -d =="
cd /root/life-os
docker compose up -d

echo "== 2/3 : service systemd claude-bridge =="
tee /etc/systemd/system/claude-bridge.service > /dev/null <<'EOF'
[Unit]
Description=Claude Code bridge for Life OS chat
After=network.target

[Service]
ExecStart=/usr/bin/env node /root/life-os/claude-bridge/server.mjs
Restart=always
RestartSec=5
User=root
WorkingDirectory=/root/life-os

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now claude-bridge
systemctl status claude-bridge --no-pager

echo "== 3/3 : timeout nginx =="
if ! grep -q "proxy_read_timeout 170s" /etc/nginx/sites-available/life-os; then
  sed -i '/proxy_set_header X-Forwarded-Proto \$scheme;/a\        proxy_read_timeout 170s;\n        proxy_send_timeout 170s;' /etc/nginx/sites-available/life-os
else
  echo "déjà présent, rien à faire"
fi
nginx -t
systemctl reload nginx

echo "== Vérification =="
sleep 1
curl -s -X POST http://172.28.1.1:4200/ask -H 'Content-Type: application/json' -d '{"message":"dis juste: ca marche"}'
echo
echo "== Terminé =="
