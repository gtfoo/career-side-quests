# Working on Career Side Quests

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

## Model choice is empirical

`src/lib/llm.ts` is provider-agnostic (Vercel AI SDK) on purpose: the adversarial
pass is meant to run on a *different lab's* model than the scoring pass, because
same-model self-critique shares the same blind spots. Set the provider per stage
via env, and settle disputes with the eval set in `evals/`, not by preference.

## Deploying

Mirrors carpark-sg: push to `main` → GitHub Actions SSHes to the droplet and
runs `scripts/deploy.sh` (hard-reset, `npm ci`, build, restart the service).
`.env.local` and `data/` are gitignored and survive deploys.

The droplet runs three Next apps behind one Caddy, each on its own port and
systemd unit:

| host | port | service |
|---|---|---|
| gtfoo.com | 3000 | gtfoo |
| carpark.gtfoo.com | 3001 | carpark |
| career-side-quests.gtfoo.com | 3002 | career-side-quests |

Because the deploy hard-resets the tree, anything not in git is lost — except
gitignored files, which is why the model API key lives in `.env.local` on the
server and nowhere else. `scripts/provision.sh` is the one-time setup for a
fresh box and is safe to re-run.

## Desktop-first

This is used on a laptop while someone reads a job posting. Mobile is not a
target yet — don't spend effort on small-screen layout until asked.
