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
# Shared by root (manual deploys) AND deploy (CI), so the file must be writable
# by both. Created 0666 deliberately: it carries no data, only the lock, and a
# root-owned lock that CI cannot open is a deploy that fails for the wrong
# reason. Which is exactly what happened the first time CI ran.
LOCK="${DEPLOY_LOCK:-/var/lock/droplet-deploy.lock}"
if command -v flock >/dev/null 2>&1; then
  if [ ! -e "$LOCK" ]; then
    ( umask 000; : > "$LOCK" ) 2>/dev/null || true
  fi
  # Distinguish "cannot open" from "waited and timed out". Collapsing them
  # reported a 30-minute wait that never happened and sent the diagnosis in
  # entirely the wrong direction.
  if exec 9>"$LOCK"; then
    if flock -w 1800 9; then
      echo "==> holding $LOCK"
    else
      echo "!!  another deploy held $LOCK for 30 minutes; giving up." >&2
      exit 1
    fi
  else
    echo "!!  cannot open $LOCK (permissions?) — continuing WITHOUT the lock." >&2
    echo "!!  fix: sudo chmod 666 $LOCK" >&2
  fi
else
  echo "!!  flock unavailable — deploys are NOT serialized on this host." >&2
fi

# Use whatever Node this host actually has, and do NOT try to select one.
#
# There is no nvm on the droplet, so an `nvm use` line here does nothing at all
# where it matters. It is not harmless, though: on a dev machine that does have
# nvm it fires and pins the build to whatever that resolves to. Measured on this
# project's own dev box, `nvm use --lts` resolves to N/A — the lts alias is not
# installed — so it silently selected nothing there either, while the addon in
# node_modules was built for 22. A pin that is wrong in one place and inert in
# the other is worse than no pin, because the build then differs from the
# runtime without saying so.
#
# The ABI guard below is the real defence, and it runs unconditionally.
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
# Configuration can now arrive from either place: an in-tree .env.local that
# Next reads itself, or a systemd EnvironmentFile outside the tree. So the check
# asks the question that actually matters — "is a key reachable from anywhere?"
# — rather than "does this particular file exist". Testing for the file alone
# would warn on every deploy once the in-tree copy is gone, and a warning that
# is always wrong trains everyone to ignore the ones that are not.
ENV_SHARED="${ENV_FILE:-/home/deploy/career-side-quests-data/env}"
_has_key=0
for f in .env.local "$ENV_SHARED"; do
  [ -f "$f" ] && grep -qE '^[A-Z_]*API_KEY=.+' "$f" && _has_key=1
done
if [ "$_has_key" -eq 0 ]; then
  echo "!!  WARNING: no populated *_API_KEY in .env.local or $ENV_SHARED." >&2
  echo "!!  The app will serve, but every read will fail with a key error." >&2
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

# better-sqlite3 is a native addon. If it was compiled against a different Node
# ABI than the one serving, it fails on the first database request — so the
# deploy would report success and the site would 500 later.
#
# It must CONSTRUCT, not merely require. The addon is not referenced in the
# entry file at all; it loads inside the Database constructor, so
# `require('better-sqlite3')` exits 0 on a genuine mismatch and cannot fail.
# Verified here: the entry file contains no reference to the .node binary.
#
# Unconditional, and BEFORE the build: npm ci is commonly a no-op when the
# lockfile is unchanged, while the host's Node can still move underneath an
# untouched node_modules — and a bad addon should fail in seconds rather than
# after a full compile. `:memory:` opens no file, so this is safe as any user.
if [ -d node_modules/better-sqlite3 ]; then
  node -e "new (require('better-sqlite3'))(':memory:').close()" \
    && echo "==> better-sqlite3 constructs under $(node -v)" \
    || { echo "!!  better-sqlite3 ABI mismatch — not building, not restarting." >&2; exit 1; }
fi

echo "==> next build"
npm run build

# The standalone server needs these copied in; Next does not do it. The unit
# runs `node .next/standalone/server.js`, so this bundle IS what is served —
# if the copy fails the site still returns 200 for every page while every
# stylesheet and script 404s. That failure is invisible to any status-code
# check, which is why it is checked here and why the check is shaped this way.
#
# Two ways to get this wrong, both of which have shipped on this box:
#
#  - Swallowing the copy's exit status. `cp … 2>/dev/null || true` cannot fail,
#    so a failed copy is indistinguishable from a successful one. That is what
#    this script did until now; it worked only because the copy kept succeeding.
#  - Guessing a subdirectory to verify. `find .next/static/css` finds nothing
#    under Tailwind v4, which inlines styles into chunks/ — so the check skips
#    itself and the deploy reports success having verified nothing. A check that
#    silently passes is worse than none, because it retires the worry.
#
# So: let cp fail loudly, then count ANY file under the copied tree and treat
# zero as fatal. Don't restart onto a bundle that cannot serve its own assets.
if [ -d .next/standalone ]; then
  cp -r .next/static .next/standalone/.next/static
  [ -d public ] && cp -r public .next/standalone/public
  ASSETS="$(find .next/standalone/.next/static -type f 2>/dev/null | wc -l)"
  if [ "$ASSETS" -eq 0 ]; then
    echo "!!  standalone bundle has NO static assets — not restarting." >&2
    echo "!!  Serving this would return 200 on every page with every asset 404ing." >&2
    exit 1
  fi
  echo "==> standalone bundle assembled ($(du -sh .next/standalone | cut -f1), ${ASSETS} static files)"
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
