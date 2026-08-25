# Working on Career Side Quests

## Shared droplet contract

Infra facts, the deploy lock, ownership, and the current phase are shared
across all four apps and maintained by the droplet agent. Read, don't edit.

@~/Git/INFRA.md

## Correspondence and tasks

Live mail is in `MAIL.md`, closed mail in `MAIL-ARCHIVE.md`, and what this app
owes in `TASKS.md`. None is imported here — mail and task state churn, and
loaded into every session they bury the rules below them. **Read `TASKS.md`
before starting work.**

`MAIL.md` is this app's **inbox**: anyone may append, only this agent removes.
Outgoing letters go in the recipient's mailbox, never here.

The flow, the letter format and the carve-outs live in `INFRA.md`, which is
imported above — so they are already in context and are deliberately not
restated. A local copy only drifts: this section taught the pre-`From:` heading
format for a day after the canonical one changed, which is the whole argument
against duplicating it. `~/Git/check-comms.sh` enforces the rules; run it rather
than trusting any prose, including this.

A `SessionStart` hook in `.claude/settings.json` counts unread letters, so a
full mailbox announces itself. It greps inline rather than calling
`check-comms.sh`, which makes ~8s of network calls and must not be a tax on
every session start. **It only fires for sessions rooted in THIS repo** — one
opened in `~/Git/gtfoo` will not see it.

## This is NOT the Next.js you know

Next 16 has breaking changes — APIs, conventions and file structure may differ
from your training data. Read the relevant guide in `node_modules/next/dist/docs/`
before writing code, and heed deprecation notices.

Ones that have already bitten this repo's neighbours:

- `params` / `searchParams` are **async** — no synchronous compatibility left.
- `middleware.ts` is renamed to `proxy.ts`.
- `next lint` is gone; `next build` no longer lints. Run `npx eslint` yourself.

## The brand lives in exactly one file

`src/config/product.ts`. Everything else imports `PRODUCT.name`. The name took
a while to settle and may still move, so keep it a one-file edit.

**Do not** put the product name in:

- component or file names (`QuestCard`, not `SideQuestCard`)
- prompt text (say "a career assessment assistant", never a brand name — a
  brand in a prompt invalidates the prompt cache and moves the eval baseline)
- table names, the SQLite filename, or env var prefixes

The internal vocabulary is worth keeping straight, because each word does real
work: a **side quest** is one scoped build that closes one gap; a **questline**
is the multi-hop bridge route for a far pivot; **carries over / to close** is
the two-axis score. Do not collapse these into "tasks".

## Assessment honesty is a product requirement, not a nicety

This app tells people where they stand against a role they want. Two rules
follow, and both are enforced in code rather than left to the model:

1. **Every score cites verbatim evidence.** A claim whose quoted span is not a
   literal substring of the source is rejected and regenerated
   (`src/lib/pipeline/validate.ts`). Models are relentlessly flattering about
   resumes; the substring check is what makes a low score trustworthy.
2. **Never invent numbers.** Generated resume bullets carry `{{placeholder}}`
   metrics. A digit outside a placeholder fails validation.

If a gap genuinely cannot be closed quickly, the product says so. Do not add
"remediation" for things like years-of-experience or headcount ownership.

## A CV never reaches a provider that trains on input

`STAGE_SEES_USER_DATA` in `src/lib/llm.ts` marks which stages are shown the
candidate's own material. Those stages may only use providers where
`mayTrainOnInput()` is false. The filter runs before any cost or quality
preference, applies to fallback chains, and cannot be overridden by
`MODEL_*` env vars — whoever sets an env var is not the person whose CV it is.

Google's **free** tier trains on submissions and permits human review; the paid
tier does not, and nothing in the API response says which you are on. So the
code assumes free unless `GOOGLE_PAID_TIER=true`. Google is still used for the
job posting, which is public text — that split is the whole point and is worth
keeping rather than banning a provider outright.

If every configured provider trains on input, a read **fails** rather than
proceeding. Running out of paid credit is not a reason to send someone's resume
somewhere it can be trained on.

Do not weaken this to make a demo work.

## Never spend tokens without being asked

Model calls are default-deny (`src/lib/spend.ts`). Two switches, both required:
`LLM_SPEND=allow` in the environment, **and** a typed `--allow-spend` on that
specific command. A standing permission in `.env.local` lets the app run; it
must never let a script spend on its own.

Do not add a bypass, do not default it to on, and do not "temporarily" relax it
while debugging. The gate lives inside `generate()`, so a new *stage* is covered
automatically — but a new *script* is not. Call `requireExplicitApproval()` at
the top of any script that can reach a model.

Verify whatever you can without spending. These never call a model:

```
npm test                 scoring, verdicts, grounding, layout, the gate itself
npm run check-routing    which model each stage would use
npm run check-grounding  quote grounder, both directions
```

## Model choice is empirical

`src/lib/llm.ts` is provider-agnostic (Vercel AI SDK) on purpose: the adversarial
pass is meant to run on a *different lab's* model than the scoring pass, because
same-model self-critique shares the same blind spots. Set the provider per stage
via env, and settle disputes with the eval set in `evals/`, not by preference.

Preference order is **OpenAI → Anthropic → Google**. The first provider with a
key becomes the primary; the next distinct one runs the adversarial pass. This
order is a project decision, not a technical one — change `PROVIDER_ORDER` if it
changes, and don't hardcode a provider anywhere else.

## Deploying

Push to `main` → GitHub Actions SSHes to the droplet and runs
`scripts/deploy.sh` (hard-reset, `npm ci`, build, restart the service).

**The host/port/service table is in `INFRA.md` and is not repeated here.** It
used to be, listing three apps when there are five — and a stale table in this
file gets believed over the correct one in the shared contract, because this is
the file a session actually loads. Same reason the note below is worded as a
pointer rather than a copy.

**Nothing this app needs is inside the tree any more.**

- Config arrives from a systemd `EnvironmentFile` at
  `/home/deploy/career-side-quests-data/env`. The in-tree `.env.local` was
  deleted on 2026-08-12; do not recreate it on the server. `deploy.sh` checks
  whether a key is reachable from *either* location, so local development with
  `.env.local` still works unchanged.
- The database is at `/home/deploy/career-side-quests-data/app.db`, set by
  `DB_PATH`. There is no in-tree `data/` directory.
- The service runs the standalone bundle: `node .next/standalone/server.js`,
  switched 2026-08-11. `deploy.sh` copies `.next/static` and `public` into it,
  because Next does not, and counts the files afterwards — a missing static
  directory serves 200 with every asset 404ing.

**`DB_PATH` has an in-tree default, and that is a latent landmine.** It falls
back to `data/app.db`. The env file overrides it, so this is inert today. But if
that line is ever lost the app silently starts writing accounts *inside the
tree* — survivable now, unrecoverable under the proposed `releases/<sha>` +
`rsync --delete` layout, which deletes anything in the target that is not in the
build artifact. If that layout is ever adopted, make an unset `DB_PATH` refuse
to boot rather than fall back.

`scripts/provision.sh` is the one-time setup for a fresh box and is safe to
re-run.

## Desktop-first

This is used on a laptop while someone reads a job posting. Mobile is not a
target yet — don't spend effort on small-screen layout until asked.
