#!/bin/bash
# Server watchdog, run every 5 minutes from the root crontab. Checks the
# services and the backups, and alerts only when a check changes state
# (down after 2 failures in a row, then "rétabli" once it passes again).
# Alerts go out as a Life OS push (POST /api/push/alert, CRON_SECRET), or by
# mail through Gmail SMTP when Life OS itself can't deliver them.
set -uo pipefail

ENV=/root/life-os/.env
STATE=${WATCHDOG_STATE:-/var/lib/life-os-watchdog}
LIFEOS_URL=https://46.224.119.108.nip.io
TENNIS_URL=https://tennis.46.224.119.108.nip.io
DISK_MAX_PCT=85
CERT_MIN_DAYS=14

mkdir -p "$STATE"
env_get() { grep "^$1=" "$ENV" | head -1 | cut -d= -f2-; }
CRON_SECRET=$(env_get CRON_SECRET)
MAIL_ACCOUNT=$(env_get MAIL_ACCOUNTS | cut -d, -f1)
MAIL_ADDR=${MAIL_ACCOUNT%%:*}
MAIL_PASS=${MAIL_ACCOUNT#*:}

send_mail() {
  [ -n "$MAIL_ADDR" ] || return 1
  printf 'From: Watchdog VPS <%s>\r\nTo: %s\r\nSubject: =?UTF-8?B?%s?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n%s\r\n' \
    "$MAIL_ADDR" "$MAIL_ADDR" "$(printf '%s' "$1" | base64 -w0)" "$2" |
    curl -s --max-time 30 --ssl-reqd smtps://smtp.gmail.com:465 \
      --user "$MAIL_ADDR:$MAIL_PASS" --mail-from "$MAIL_ADDR" --mail-rcpt "$MAIL_ADDR" -T - >/dev/null
}

send_push() {
  local payload
  payload=$(python3 -c 'import json,sys; print(json.dumps({"title":sys.argv[1],"body":sys.argv[2],"tag":sys.argv[3]}))' "$1" "$2" "$3")
  curl -s --max-time 15 -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
    -d "$payload" http://127.0.0.1:4100/api/push/alert | grep -q '"delivered":[1-9]'
}

alert() { # name, title, body
  echo "$(date -u +%FT%TZ) $1: $2 / $3"
  send_push "$2" "$3" "$1" || send_mail "$2" "$3" || echo "  (alerte non délivrée)"
}

# check NAME "description" COMMAND... : COMMAND must succeed when all is well
# and print the reason on failure.
check() {
  local name=$1 label=$2; shift 2
  local out fails
  fails=$(cat "$STATE/$name.fails" 2>/dev/null || echo 0)
  if out=$("$@" 2>&1); then
    if [ "$fails" -ge 2 ]; then alert "$name" "✅ $label rétabli" "Tout est revenu à la normale."; fi
    echo 0 > "$STATE/$name.fails"
  else
    fails=$((fails + 1))
    echo "$fails" > "$STATE/$name.fails"
    if [ "$fails" -eq 2 ]; then alert "$name" "🔴 $label en panne" "${out:-échec du contrôle}"; fi
  fi
}

http_up() { # any answer below 500 means the app is serving
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1")
  [ "$code" -ge 200 ] && [ "$code" -lt 500 ] || { echo "$1 répond $code"; return 1; }
}

disk_ok() {
  local pct
  pct=$(df --output=pcent / | tail -1 | tr -dc 0-9)
  [ "$pct" -lt "$DISK_MAX_PCT" ] || { echo "Disque plein à $pct %"; return 1; }
}

fresh() { # glob, max age in hours
  local latest
  latest=$(ls -1t $1 2>/dev/null | head -1)
  [ -n "$latest" ] || { echo "Aucun fichier $1"; return 1; }
  [ $(( $(date +%s) - $(stat -c %Y "$latest") )) -lt $(( $2 * 3600 )) ] || { echo "Dernière sauvegarde : $(basename "$latest")"; return 1; }
}

offsite_ok() {
  tail -1 /var/log/life-os/offsite-backup.log | grep -q "Offsite backup OK" &&
    [ $(( $(date +%s) - $(stat -c %Y /var/log/life-os/offsite-backup.log) )) -lt $(( 26 * 3600 )) ] ||
    { echo "Dernière ligne du log : $(tail -1 /var/log/life-os/offsite-backup.log)"; return 1; }
}

cert_ok() { # host
  local end
  end=$(echo | openssl s_client -servername "$1" -connect "$1:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -n "$end" ] || { echo "Certificat illisible pour $1"; return 1; }
  [ $(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 )) -ge "$CERT_MIN_DAYS" ] || { echo "Le certificat de $1 expire le $end"; return 1; }
}

check lifeos     "Life OS"              http_up "$LIFEOS_URL/api/goals"
check tennis     "Site Tennis"          http_up "$TENNIS_URL/"
check bridge     "Pont Claude"          systemctl is-active --quiet claude-bridge
check disk       "Disque du serveur"    disk_ok
check bk_lifeos  "Sauvegarde Life OS"   fresh "/root/life-os-backups/data-[0-9]*.sqlite" 26
check bk_tennis  "Sauvegarde Tennis"    fresh "/root/Tennis_Wesbite/backups/tennis-*.sql" 26
check bk_offsite "Sauvegarde distante"  offsite_ok
check cert_lifeos "Certificat Life OS"  cert_ok "${LIFEOS_URL#https://}"
check cert_tennis "Certificat Tennis"   cert_ok "${TENNIS_URL#https://}"
