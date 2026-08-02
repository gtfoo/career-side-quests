#!/usr/bin/env bash
#
# Build the currently checked-out commit and restart the service.
#
# The GitHub Actions "Deploy to droplet" workflow updates git first, then runs
# this over SSH. To deploy by hand on the droplet:
#
#     cd ~/career-side-quests && git pull --ff-only && bash scripts/deploy.sh
#
# .env.local (model API keys) is gitignored and lives only on the server, so
# nothing here touches it — but the build DOES need it, and a missing key is
# the most likely reason a fresh box serves 500s. That is checked below.
set -euo pipefail

# Repo root, regardless of where it's cloned or called from.
cd "$(dirname "$0")/.."

# Prefer nvm's Node 20 if this host uses nvm; otherwise fall back to the system
# Node on PATH (the droplet's deploy user has system Node 20, no nvm).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use 20 >/dev/null
fi

SERVICE="${SIDEQUESTS_SERVICE:-career-side-quests}"

# Warn loudly rather than shipping a build that will 500 on every read. Not
# fatal: the input screen and posting lookup work without a model key, so a
# keyless deploy is degraded, not broken.
if [ ! -f .env.local ]; then
  echo "!!  WARNING: no .env.local on this host." >&2
  echo "!!  The app will serve, but every read will fail with a key error." >&2
elif ! grep -qE '^[A-Z_]*API_KEY=.+' .env.local; then
  echo "!!  WARNING: .env.local has no populated *_API_KEY." >&2
fi

echo "==> npm ci"
npm ci

echo "==> next build"
npm run build

echo "==> restarting ${SERVICE}"
sudo systemctl restart "${SERVICE}"

# Confirm it actually came back. A silent restart failure looks identical to a
# successful deploy in the Actions log, which is how a site stays down unnoticed.
sleep 4
if systemctl is-active --quiet "${SERVICE}"; then
  echo "==> deployed $(git rev-parse --short HEAD) on $(hostname)"
else
  echo "!!  ${SERVICE} did not come back up:" >&2
  systemctl status "${SERVICE}" --no-pager --lines=20 >&2 || true
  exit 1
fi
