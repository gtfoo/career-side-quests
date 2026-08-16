#!/usr/bin/env bash
#
# Mutation harness for scripts/check-signin-email.ts.
#
#     bash scripts/mutate-signin-email.sh
#
# Breaks the sign-in email on purpose, one way at a time, and asserts the check
# NOTICES. A check that cannot fail is worse than no check, because it retires
# the worry — and this file exists because that happened here twice:
#
#   - "states the expiry" asked whether "15" appeared anywhere in the body. The
#     HTML carries font-size:15px, so it passed on the stylesheet. The sentence
#     could have said five minutes, or nothing, and the check stayed green.
#   - "the URL appears as copyable text" counted occurrences and wanted two,
#     which the href attributes satisfy by themselves.
#
# Both read as correct. Both were found by mutating rather than by reading, and
# only after the 1-percent-more-fluent agent mutated their own copy and reported
# that two of theirs survived. Running the suite green proves nothing about
# whether it would have caught anything.
#
# No network and no key: the check renders the email in-process.
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET=src/lib/signin-email.ts
BACKUP="$(mktemp)"
cp "$TARGET" "$BACKUP"
restore() { cp "$BACKUP" "$TARGET"; rm -f "$BACKUP"; }
trap restore EXIT

pass=0
fail=0

# Applies a sed expression to the email module, runs the check, and requires it
# to FAIL. Skips loudly if the mutation did not actually change the file —
# a sed that matches nothing silently proves nothing, which is how a mutation
# test becomes as vacuous as the assertion it is meant to police.
mutate() {
  local name="$1" expr="$2"
  cp "$BACKUP" "$TARGET"
  sed -i "$expr" "$TARGET"
  if cmp -s "$BACKUP" "$TARGET"; then
    printf '  \033[33mSKIP\033[0m  %s — pattern did not match; the mutation is stale\n' "$name"
    fail=$((fail + 1)); return
  fi
  if npx tsx scripts/check-signin-email.ts >/dev/null 2>&1; then
    printf '  \033[31mSURVIVED\033[0m  %s — the check did not notice\n' "$name"
    fail=$((fail + 1))
  else
    printf '  \033[32mcaught\033[0m    %s\n' "$name"
    pass=$((pass + 1))
  fi
}

echo "== mutating the sign-in email; every line should be caught =="

# The two that once survived.
mutate "expiry copy drifts away from LINK_MINUTES" \
  's/expires in ${LINK_MINUTES} minutes/expires in 5 minutes/'
# Note the fallback is a <span>, not a link — which is why the check strips all
# tags rather than asserting >URL</a> as fluent's does. Their form would pass
# here while the address was invisible.
mutate "the visible fallback stops showing the address" \
  's|>${href}</span>|>click here</span>|'

# The one that actually breaks sign-in: an unescaped & truncates the token in
# some clients, and the symptom is indistinguishable from an expired link.
mutate "the href stops escaping &" 's/\.replace(\/&\/g, "&amp;")//'

# Things email clients discard. Each is a real client behaviour.
mutate "an <img> becomes load-bearing" \
  's|<td|<td><img src="https://example.com/logo.png" alt="x">|'
mutate "layout switches to flex, which Outlook renders through Word" \
  's/<table/<div style="display:flex"/'
mutate "the plain-text part is dropped" 's/^  return { subject, html, text }/  return { subject, html, text: "" }/'
mutate "the single-use sentence goes" 's/ and can be used once//'
mutate "the product name goes from the subject" \
  's/Your ${PRODUCT.name} sign-in link/Sign-in link/'

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m✓\033[0m %d mutations, all caught\n' "$pass"
else
  printf '\033[31m✗\033[0m %d caught, %d NOT caught — fix the check, not this file\n' "$pass" "$fail"
fi
exit "$fail"
