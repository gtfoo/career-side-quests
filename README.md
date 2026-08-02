# Career Side Quests

See exactly where you stand for the job you want — and the shortest route
across the gap.

Point it at a role and give it whatever evidence you have. It scores you
requirement by requirement, cites the exact line behind every score, and routes
each gap to the cheapest thing that actually closes it. It works at any
distance, from a sideways move to a career change.

**Live:** https://career-side-quests.gtfoo.com

## Why the output can be trusted

Most resume matchers measure how well you wrote your CV. These are the
decisions that make this one measure something closer to the truth:

- **No model ever emits a score.** Models return per-requirement levels with
  quoted evidence; the arithmetic happens in TypeScript. Ask a model for a
  percentage and you get a plausible one that moves when you rephrase the
  prompt.
- **Every claim carries a verbatim quote**, checked as a literal substring of
  its source. Ungrounded claims are rejected and regenerated. Hallucination
  becomes a cheap string check.
- **Counter-evidence is mandatory.** Models flatter resumes by default, so each
  score must also surface what cuts against it — and the UI shows it.
- **Eligibility is a gate, not a score.** Averaging "can't legally work here"
  into a capability percentage is wrong in both directions.
- **The app cannot invent numbers.** Generated CV bullets carry
  `{{placeholder}}` metrics; a digit outside a placeholder fails validation.
- **Parse coverage is surfaced, never swallowed.** A CV that silently yields one
  page of fourteen would otherwise be scored as if that were the whole person.

## Running it

```bash
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3002
```

Two providers are better than one: the adversarial pass runs on a *different
lab's* model than the scoring pass when a second key is present, because
same-model self-critique shares the same blind spots.

### Useful scripts

```bash
npm run spike -- --posting <url|file> --cv <file>   # score N times, report variance
npm run try-posting -- <url>                        # check a board adapter, no model call
npm run typecheck
```

`spike` is the quality gate: if the same inputs swing more than ~10 points
between runs, the rubric is underspecified and no amount of UI will fix it.

## Deploying

Push to `main` → GitHub Actions SSHes to the droplet and runs
`scripts/deploy.sh` (hard-reset, `npm ci`, build, restart the service).
`.env.local` and `data/` are gitignored and survive deploys.

First time on a new box: `sudo bash scripts/provision.sh` (clone, systemd unit,
Caddy vhost, first build). Needs the DNS record to exist first.

Required repo secrets: `DROPLET_HOST`, `DROPLET_USER`, `DROPLET_SSH_KEY`,
`DROPLET_APP_DIR`, and optionally `DROPLET_PORT`.

## Layout

```
src/lib/schema.ts          the contract every stage speaks
src/lib/llm.ts             per-stage provider routing + fallback chains
src/lib/ingest/            job boards (Ashby/Greenhouse/Lever), CV parsing
src/lib/pipeline/
  extract.ts               JD -> requirements, materials -> evidence
  match.ts                 one requirement per call, skeptical reviewer
  validate.ts              verbatim-quote checks, regenerate on failure
  aggregate.ts             scoring, verdict, distance — all deterministic
  assess.ts                the orchestrator
src/app/                   input screen, read screen, API routes
```

See `AGENTS.md` before changing anything — it records the constraints that are
load-bearing rather than incidental.
