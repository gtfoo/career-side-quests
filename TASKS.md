# Tasks — career-side-quests

What this app owes. **Written only by this app's agent**; readable by anyone.
Tasks may be suggested by the owner, by this agent, or by another agent — they
arrive as mail and get recorded here. Never imported: this file churns.

Every task carries a `from:` pointer, because the reasoning usually lives in a
letter or a commit and a one-line task strands the *why*.

Adopted 2026-08-15 with the correspondence protocol. Unlike the reference
seeding in `gtfoo/TASKS.md`, every item below was **checked against the code or
the box** before being written down, so this file is authoritative as of that
date.

## Open

- [ ] **Set `AUTH_PASSKEYS=1` in the production env** —
      `/home/deploy/career-side-quests-data/env`. The whole passkey flow shipped
      2026-08-17 (registration and revocation on `/data`, adapter fixed) but the
      provider is not registered until this is set, so no user can reach it and
      the counts file correctly reports `passkey: null`. Owner's to set; I have
      no write access to the droplet.
      `from: owner asked for passkeys · blocked on one env line`

- [ ] **`AUTH_SECRET` in `.env.local` ends with a stray quote** — 45 characters,
      a trailing `"` with no opening one. Harmless while both sides read the
      same string, and sign-in works, but it means the secret is not what was
      intended and a regeneration would change behaviour silently. Worth
      checking the production copy has not got the same.
      `from: this agent · found while minting a test session`

- [ ] **Progressive rendering for the read.** A full read takes ~384s and the
      screen shows a spinner for all of it. This is the largest usability
      problem in the app and nothing else on this list is close. The pipeline
      already completes in stages, so the work is streaming them to the client
      rather than awaiting the whole assessment.
      `from: owner, in session · biggest known UX gap`

- [ ] **Decide whether `/signin` should prerender again.** It moved from static
      to dynamic when `sendVerificationRequest` landed; it reads headers for
      session state, so dynamic is arguably correct — a prerendered sign-in page
      cannot reflect that you are already signed in. Works either way; flagged
      because it was an unintended consequence, not a decision.
      `from: this agent · noticed one commit late · owner has not ruled`

- [ ] **Verify the print path in Safari.** `usePrintable` registers
      `beforeprint`/`afterprint` *and* a `matchMedia("print")` listener because
      Safari fires only the latter. The fallback is reasoned, not measured — no
      Safari available here.
      `from: this agent · stated as a limit when Save as PDF shipped`

- [ ] **Verify a side quest renders correctly in print.** The locked CV-lines
      block is blurred on screen and would print as a grey smear, so the print
      stylesheet drops it. That is a code-and-CSS check only: producing a brief
      costs a model call, and spending is gated on explicit approval.
      `from: this agent · same limit · needs one approved live run`

- [ ] **Unbuilt pipeline stages: `translate`, `adversary`, `quiz`.** Routed in
      `src/lib/llm.ts` with tiers and PII rules already assigned, but no
      implementation behind them. Not requested; listed so the routing table is
      not mistaken for working features.
      `from: this agent · routing exists, stages do not`

- [ ] **Far-distance (D3/D4) outputs and the anonymous-read claim flow.** Both
      designed in the mockups, neither built. The claim flow must use
      `events.signIn`, not the callback.
      `from: design · not scheduled`

## Blocked

- [ ] **Phase 2 pilot — accepted, awaiting approval.** This app volunteered and
      the droplet agent recorded it under Current phase, conditional on two
      things being *in* the pilot rather than follow-ups: pin `runs-on:
      ubuntu-24.04` (never `ubuntu-latest`) and `node-version: 22.23.2`
      exactly, because the `better-sqlite3` binary ships inside the artifact
      and inherits the runner's glibc; and relocate the ABI guard to run after
      the rsync and before the symlink flip, since there will be no build on
      the droplet for the current guard to check.
      **`runs-on: ubuntu-latest` is CORRECT today and becomes wrong the moment
      the build moves.** The workflow is a pure SSH deployer — no checkout, no
      `setup-node`, no `npm` — so the runner is an SSH client and its Node is
      irrelevant. Audited 2026-08-30 and found clean. The trap is that nothing
      is wrong beforehand, so there is no failing check to remind anyone: it is
      a migration step, not a defect. `carpark-sg/.github/workflows/deploy.yml`
      is the fleet's only existing `setup-node` if a reference is wanted.
      Local side is already ready: `.nvmrc` says 22, and the addon constructs
      under v22.23.2 after the owner's WSL update — verified, not assumed.
      `from: droplet · phase 2 consultation · BLOCKED: "nothing is approved and
      nothing is scheduled, please do not implement any of this"`

- [ ] **Make an unset `DB_PATH` refuse to boot.** It currently falls back to the
      in-tree `data/app.db`. Verified inert today — the env file sets it, the
      live process has it, it points outside the tree, and no in-tree `data/`
      exists — but under `rsync --delete` a lost env line means accounts are
      written into the tree and destroyed by the next deploy. Recorded in
      `AGENTS.md` too, since it outlives this list.
      `from: this agent · phase 2 consultation · do with the phase 2 work`

## Declined

Kept rather than dropped: a declined task that leaves no trace gets proposed
again, and the second refusal costs the same conversation as the first.

- [x] **An `/admin`-style view on `/var/lib/analytics/career-side-quests.json`.**
      Collection is already running for this host, so the file exists and a view
      would work. Declined for now anyway — gtfoo.com owns the analytics
      dashboard and a second one here would be a duplicate surface reading the
      same files, against the standing rule that collection is shared and views
      are built on it rather than beside it. Told the droplet agent explicitly
      not to treat this app as a consumer yet, so reformatting need not wait.
      `from: droplet · analytics interface contract · revisit only if this app
      needs something gtfoo's dashboard cannot show`
