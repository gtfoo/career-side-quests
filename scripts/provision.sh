#!/usr/bin/env bash
#
# ONE-TIME droplet setup for career-side-quests.gtfoo.com.
# Run as root on the droplet, once. Safe to re-run: it is idempotent.
#
#     sudo bash provision.sh
#
# Prerequisites:
#   - a DNS A record for career-side-quests.gtfoo.com -> this droplet's IP
#     (Caddy cannot get a certificate until this resolves)
#   - the deploy user and Caddy already exist (they do, from the other apps)
set -euo pipefail

APP="career-side-quests"
PORT=3002
HOST="career-side-quests.gtfoo.com"
REPO="git@github.com:gtfoo/career-side-quests.git"
DIR="/home/deploy/${APP}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash provision.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------- 1. clone
if [ ! -d "$DIR/.git" ]; then
  echo "==> cloning into $DIR"
  sudo -u deploy -H git clone "$REPO" "$DIR"
else
  echo "==> $DIR already cloned"
fi

# --------------------------------------------------------------- 2. secrets
# The app needs a model API key. It is deliberately NOT in git, so it has to be
# placed here by hand once; deploys preserve it.
if [ ! -f "$DIR/.env.local" ]; then
  sudo -u deploy -H tee "$DIR/.env.local" >/dev/null <<'ENV'
# Fill this in, then: sudo systemctl restart career-side-quests
ANTHROPIC_API_KEY=
ENV
  chmod 600 "$DIR/.env.local"
  chown deploy:deploy "$DIR/.env.local"
  echo "!!  Created $DIR/.env.local with an EMPTY key."
  echo "!!  Put the real key in it before the app can run a read."
fi

# --------------------------------------------------------------- 3. service
echo "==> writing systemd unit"
tee "/etc/systemd/system/${APP}.service" >/dev/null <<UNIT
[Unit]
Description=Career Side Quests (Next.js)
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=${DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run start -- -p ${PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${APP}"

# ------------------------------------------------------- 4. first build
echo "==> first build"
sudo -u deploy -H bash -lc "cd '${DIR}' && npm ci && npm run build"
systemctl restart "${APP}"
sleep 4
systemctl is-active --quiet "${APP}" && echo "==> ${APP} is up on :${PORT}"

# ----------------------------------------------------------------- 5. caddy
# Appended rather than rewriting the Caddyfile, so the existing gtfoo.com and
# carpark.gtfoo.com blocks are left untouched.
if grep -q "${HOST}" /etc/caddy/Caddyfile; then
  echo "==> Caddyfile already has ${HOST}"
else
  echo "==> adding ${HOST} to Caddyfile"
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
  tee -a /etc/caddy/Caddyfile >/dev/null <<CADDY

# Career Side Quests (its own service), auto-HTTPS
${HOST} {
	encode zstd gzip
	reverse_proxy localhost:${PORT}
}
CADDY
  caddy validate --config /etc/caddy/Caddyfile
  systemctl reload caddy
  echo "==> reloaded caddy; provisioning certificate for ${HOST}…"
  sleep 12
fi

echo
curl -s -o /dev/null -w "local  :${PORT} -> HTTP %%{http_code}\n" "http://localhost:${PORT}" || true
curl -s -o /dev/null -w "public ${HOST} -> HTTP %%{http_code}\n" "https://${HOST}" || true
echo "PROVISION_DONE"
