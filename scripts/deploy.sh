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

# This script runs as root over SSH while the checkout is owned by `deploy`,
# which newer git refuses to read ("detected dubious ownership"). The deploy
# still works without this, but every git call fails silently — so the closing
# line reports an empty commit, and a deploy log that cannot tell you what is
# live is worse than no deploy log.
git config --global --add safe.directory "$PWD" >/dev/null 2>&1 || true

# ---------------------------------------------------------------- the lock
#
# One box, four Next apps, and each repo's CI concurrency group only serializes
# against ITSELF — GitHub cannot serialize across repositories. Two apps have
# already built simultaneously here. On ~600MB of available RAM that is not a
# slow deploy, it is an OOM.
#
# This matters more for this app than the others: it is the only one with a
# native addon (better-sqlite3), and `npm ci` compiles it. The lock is shared
# by path, so every app's deploy.sh must use the SAME file for it to work.
LOCK="${DEPLOY_LOCK:-/var/lock/droplet-deploy.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK" || true
  if ! flock -w 1800 9; then
    echo "!!  another deploy held $LOCK for 30 minutes; giving up." >&2
    exit 1
  fi
  echo "==> holding $LOCK"
else
  echo "!!  flock unavailable — deploys are NOT serialized on this host." >&2
fi

# Use whatever Node this host actually has. There is no nvm on the droplet and
# the system Node is 22; an earlier version of this script asked nvm for 20,
# which silently did nothing. Pinning a version that is not installed is worse
# than not pinning one, because the build then differs from the runtime without
# saying so — and a native addon compiled against the wrong ABI fails at
# require() time, long after the deploy reports success.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use --lts >/dev/null 2>&1 || true
fi
echo "==> node $(node -v) / npm $(npm -v)"

SERVICE="${SIDEQUESTS_SERVICE:-career-side-quests}"

# A native addon build is the memory-hungriest step here, and this box has run
# out before. Report the headroom so a failed deploy is diagnosable from the log
# rather than from guesswork.
if command -v free >/dev/null 2>&1; then
  echo "==> memory available: $(free -m | awk 'NR==2{print $7}') MB"
fi

# Warn loudly rather than shipping a build that will 500 on every read. Not
# fatal: the input screen and posting lookup work without a model key, so a
# keyless deploy is degraded, not broken.
if [ ! -f .env.local ]; then
  echo "!!  WARNING: no .env.local on this host." >&2
  echo "!!  The app will serve, but every read will fail with a key error." >&2
elif ! grep -qE '^[A-Z_]*API_KEY=.+' .env.local; then
  echo "!!  WARNING: .env.local has no populated *_API_KEY." >&2
fi

# The database is gitignored, so a hard-reset deploy leaves it alone — but it
# now holds real accounts, and losing it is unrecoverable. Say where it is and
# how big, so a deploy that ever does destroy it is visible in the log.
DB="${DB_PATH:-data/app.db}"
if [ -f "$DB" ]; then
  echo "==> database present: $DB ($(du -h "$DB" | cut -f1))"
fi

echo "==> npm ci"
npm ci

echo "==> next build"
npm run build

# better-sqlite3 is a native addon compiled during npm ci. If it was built
# against a different Node ABI than the one serving, it fails at require() —
# which happens on the first request, not here, so the deploy would report
# success and the site would 500. Load it now, while the log is still watching.
if [ -d node_modules/better-sqlite3 ]; then
  node -e "require('better-sqlite3'); console.log('==> better-sqlite3 loads under', process.version)" \
    || { echo "!!  better-sqlite3 will not load — ABI mismatch. Not restarting." >&2; exit 1; }
fi

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
