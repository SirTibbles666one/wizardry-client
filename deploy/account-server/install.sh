#!/usr/bin/env bash
# Installs or updates the Wizardry account server on this machine. Run as root:
#
#   deploy/account-server/install.sh path/to/account-server.mjs
#
# Build the file first with `npm run build:account-server` (it lands in server/).
# Safe to run again: an existing settings file and its pepper are left alone.
# Prints no secrets. What it leaves for you: the CHANGE lines in the settings
# file, the nginx vhost (nginx.conf here), and DNS for the hostname.
set -euo pipefail

BUNDLE="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/wizardry-accounts
ETC_DIR=/etc/wizardry-accounts
ENV_FILE="$ETC_DIR/env"
SVC=wizardry-accounts

die() { echo "install: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -n "$BUNDLE" ] && [ -f "$BUNDLE" ] || die "usage: install.sh path/to/account-server.mjs"
command -v node >/dev/null || die "node is not installed (22.13 or newer is needed)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "node $(node -v) is too old: 22.13 or newer is needed for the built-in SQLite"
command -v openssl >/dev/null || die "openssl is not installed"

id -u "$SVC" >/dev/null 2>&1 || useradd --system --home-dir /var/lib/$SVC --shell /usr/sbin/nologin "$SVC"

install -d -m 0755 "$APP_DIR"
install -m 0644 "$BUNDLE" "$APP_DIR/account-server.mjs"
install -m 0755 "$HERE/backup.sh" "$APP_DIR/backup.sh"
install -d -m 0700 -o "$SVC" -g "$SVC" /var/lib/$SVC
install -d -m 0750 -o root -g "$SVC" "$ETC_DIR"

fresh=0
if [ ! -f "$ENV_FILE" ]; then
  fresh=1
  umask 027
  # The pepper goes straight from openssl into the file; it is never shown.
  sed "s/^ACCOUNT_PEPPER=$/ACCOUNT_PEPPER=$(openssl rand -hex 32)/" "$HERE/env.example" > "$ENV_FILE"
  chown root:"$SVC" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
fi
grep -Eq '^ACCOUNT_PEPPER=[0-9a-f]{64,}$' "$ENV_FILE" || die "$ENV_FILE has no valid ACCOUNT_PEPPER"

install -m 0644 "$HERE/$SVC.service" /etc/systemd/system/$SVC.service
systemctl daemon-reload

if grep -q 'example\.com' "$ENV_FILE"; then
  echo "install: files are in place. Not started yet:"
  echo "  1. edit the CHANGE lines in $ENV_FILE"
  echo "  2. copy the pepper line somewhere that is NOT where the database backups go"
  echo "  3. systemctl enable --now $SVC"
  [ "$fresh" = 1 ] || echo "  (the settings file still has example.com in it)"
  exit 0
fi

systemctl enable "$SVC" >/dev/null
systemctl restart "$SVC"
sleep 1
port="$(sed -n 's/^PORT=//p' "$ENV_FILE")"
if curl -fsS "http://127.0.0.1:${port:-8787}/healthz" >/dev/null; then
  echo "install: $SVC is running and answering on port ${port:-8787}"
else
  die "$SVC did not answer; see: journalctl -u $SVC -n 30"
fi
