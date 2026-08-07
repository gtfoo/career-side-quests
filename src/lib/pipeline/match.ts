import { generate } from "@/lib/llm";
import {
  RequirementMatch,
  RequirementMatchBatch,
  type CandidateProfile,
  type JobTarget,
  type Requirement,
} from "@/lib/schema";
import { checkIds, checkQuotes, withValidation } from "./validate";

/**
 * Stage 4: score ONE requirement against the candidate's evidence.
 *
 * Deliberately one requirement per call, run in parallel. Scoring all of them
 * in a single call makes the levels drift toward each other — the model settles
 * on an overall impression of the candidate and distributes levels to match it,
 * which is exactly the vibes-based scoring this pipeline exists to avoid.
 *
 * The calls share a long identical prefix (the JD and the evidence), so this
 * costs far less than it looks: the first call writes the prompt cache and the
 * rest read it. Fire one, wait for it to start, then fan out the remainder —
 * requests issued in parallel all miss a cache none of them has written yet.
 */

const MATCH_SYSTEM = `You judge whether a candidate's evidence meets ONE specific requirement.

You are a skeptical reviewer, not an encouraging one. Resumes are written to
persuade, and the default failure of this task is being too generous.

## Choosing the level

Do NOT judge the evidence holistically. Work through these questions IN ORDER
and stop at the first one that applies. The level depends on what KIND of
evidence exists, not on how impressive it sounds.

1. Is there no evidence bearing on this requirement at all?
   -> level 0

2. Is the strongest evidence only an assertion — a skills-list entry, a
   self-description, an adjective — with no role, outcome or artifact attached?
   -> level 1
   (This holds regardless of seniority. "Proficient in Python" with nothing
   attached is a 1.)

3. Is the strongest evidence a role, title or responsibility that implies the
   requirement, but with no specific named outcome, artifact, metric, customer,
   product or event demonstrating it?
   -> level 2

4. Is there at least one SPECIFIC named thing — a shipped artifact, a named
   customer or product, a measured outcome, a named event — that demonstrates
   the requirement directly?
   -> level 3

## When a statement IS the evidence

The steps above assume an artifact is possible. For some requirements it is not,
and applying them blindly produces nonsense — scoring a native speaker 1/3 on a
language because a CV languages table is "a skills-list entry".

Where the requirement is an ATTRIBUTE rather than a skill — a language, a
degree, a certification, citizenship or work authorisation — a clear, specific
statement by the candidate IS the evidence, and there is nothing further to
demand:

  "Mandarin Chinese — Native / Bilingual"     -> level 3
  "Bachelor of Computing, NUS"                -> level 3
  "Singapore Citizen"                         -> level 3
  "some Spanish"                              -> level 1, because it is vague

Judge these on how specific and unambiguous the claim is, not on whether an
artifact is attached. A stated proficiency level is specific. "Familiar with"
is not.

Three tie-breakers, because these are where this judgement drifts between runs:
- Take the STRONGEST single piece of evidence, not the average of it.
- If the requirement names a specific technology, tool or language, the evidence
  must involve THAT one. Evidence about a neighbouring technology caps the
  level at 2, however strong it is otherwise.
- Being unsure between two levels is not a reason to pick the higher one. Pick
  the lower and say why in "reasoning".

## The rest

- Cite by atom id, and quote EXACTLY from the candidate's material, character for character. Copy the span; do not tidy, trim or paraphrase it.
- You MUST fill "counter" whenever anything cuts against the level — a claim with no artifact, a repo in a different language than claimed, experience that is years stale. If you genuinely find nothing, return an empty array, but look first.
- A counter observation is often about something ABSENT, which cannot be quoted. Set its "quote" to null unless you are copying a real span that is present in the material. Never write a quote to illustrate a gap.
- Write "reasoning" TO the candidate, in second person, and NAME the numbered step that decided the level. This is their self-assessment, not a hiring panel's verdict: be direct about what is missing without being discouraging about the person.
- Judge only the requirement in front of you. Do not consider the role overall.`;

function renderEvidence(profile: CandidateProfile): string {
  return profile.atoms
    .map((a) => `[${a.id}] (${a.kind}) ${a.summary}\n    "${a.quote}"`)
    .join("\n");
}

export async function matchRequirement(args: {
  requirement: Requirement;
  profile: CandidateProfile;
  target: JobTarget;
  /** Concatenated candidate source text, for verbatim checking. */
  candidateSource: string;
}) {
  const { requirement, profile, target, candidateSource } = args;
  const knownIds = new Set(profile.atoms.map((a) => a.id));

  // Everything IDENTICAL across the fan-out goes in the system prompt, and the
  // one thing that varies goes in the user prompt. Prompt caching is a prefix
  // match, so a single varying byte early on makes everything after it
  // uncacheable — and the evidence block is by far the largest part.
  //
  // This was originally the other way round: the requirement sat above the
  // evidence, so all eight calls paid full price for the same few thousand
  // tokens and the response came back with cacheReadTokens: 0.
  const sharedContext = [
    MATCH_SYSTEM,
    "",
    `Role: ${target.title}${target.company ? ` at ${target.company}` : ""}`,
    "",
    "Candidate evidence:",
    renderEvidence(profile),
  ].join("\n");

  const { value, issues } = await withValidation({
    label: `match:${requirement.id}`,
    attempt: async (feedback) =>
      generate({
        stage: "match",
        schema: RequirementMatch,
        system: sharedContext,
        isRetry: Boolean(feedback),
        prompt: [
          `Requirement ${requirement.id} (${requirement.kind}, ${
            requirement.mustHave ? "required" : "preferred"
          }):`,
          requirement.text,
          `Stated in the posting as: "${requirement.quote}"`,
          feedback,
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    validate: (res) => {
      const m = res.object;
      return [
        ...checkIds(
          m.supporting.map((s) => ({
            path: `supporting ${s.atomId}`,
            id: s.atomId,
          })),
          knownIds,
        ),
        ...checkQuotes(
          [
            ...m.supporting.map((s) => ({
              path: `supporting ${s.atomId}`,
              quote: s.quote,
            })),
            ...m.counter.map((c, i) => ({
              path: `counter ${i}`,
              quote: c.quote,
            })),
          ],
          candidateSource,
        ),
      ];
    },
  });

  // The schema cannot express "this id must equal that requirement", so pin it
  // here rather than trusting the model to echo it back correctly.
  return {
    match: { ...value.object, requirementId: requirement.id },
    modelSpec: value.modelSpec,
    issues,
  };
}

/**
 * Score every requirement. The first call runs alone so it can write the shared
 * prompt-cache prefix; the rest then read it instead of each paying to rewrite
 * it. Skips eligibility requirements — those are a gate, handled separately.
 */
/**
 * How many requirement calls may be in flight at once.
 *
 * Unbounded parallelism is free on a paid tier and fatal on a free one: Gemini's
 * free tier allows 5 requests per MINUTE, so an eight-way fan-out 429s before
 * the first response lands. Set MATCH_CONCURRENCY=1 to make a free tier viable
 * (slower, but it completes).
 */
function concurrency(): number {
  const raw = Number(process.env.MATCH_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
}

/** Run tasks with a ceiling on how many are in flight. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Score every requirement in ONE call instead of one call each.
 *
 * Cheaper, and the saving is in output rather than input: eight separate
 * reasoning passes over the same evidence collapse into one. Input was already
 * close to a wash once the shared prefix became cacheable.
 *
 * What it risks, and why this is a switch rather than a replacement:
 *
 *  - Halo. Seeing every requirement at once invites calibrating them against
 *    each other, so levels drift toward one overall impression of the person.
 *  - Position. Requirement 8 gets less attention than requirement 1.
 *  - Output pressure. Eight judgements share one output ceiling, and the first
 *    thing squeezed is counter-evidence — which is the anti-flattery mechanism.
 *    Nothing visibly breaks; the scores just get generous.
 *
 * Which effect dominates is an empirical question, so `npm run spike` decides
 * it. Compare spread, per-requirement stability and cost across both.
 */
async function matchBatch(args: {
  target: JobTarget;
  profile: CandidateProfile;
  candidateSource: string;
  requirements: Requirement[];
}) {
  const { target, profile, candidateSource, requirements } = args;
  const knownIds = new Set(profile.atoms.map((a) => a.id));

  const sharedContext = [
    MATCH_SYSTEM,
    "",
    "You are scoring SEVERAL requirements in one pass. Judge each one on its",
    "own evidence. Do NOT let a strong showing on one requirement lift another,",
    "and do not spread levels to look balanced — it is normal and correct for a",
    "candidate to be a 3 on most and a 0 on one.",
    "",
    `Role: ${target.title}${target.company ? ` at ${target.company}` : ""}`,
    "",
    "Candidate evidence:",
    renderEvidence(profile),
  ].join("\n");

  const { value, issues } = await withValidation({
    label: "match:batch",
    attempt: async (feedback) =>
      generate({
        stage: "match",
        schema: RequirementMatchBatch,
        system: sharedContext,
        isRetry: Boolean(feedback),
        prompt: [
          "Score each of these requirements. Return one entry per requirement,",
          "with its requirementId echoed exactly.",
          "",
          ...requirements.map(
            (r) =>
              `${r.id} (${r.kind}, ${r.mustHave ? "required" : "preferred"}): ${r.text}\n   posting says: "${r.quote}"`,
          ),
          feedback,
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    validate: (res) => {
      const got = new Set(res.object.matches.map((m) => m.requirementId));
      const missing = requirements.filter((r) => !got.has(r.id));
      return [
        // A batch can silently drop a requirement, which a per-call run cannot.
        ...missing.map((r) => ({
          path: `requirement ${r.id}`,
          problem: "missing from the batch",
        })),
        ...res.object.matches.flatMap((m) => [
          ...checkIds(
            m.supporting.map((s) => ({
              path: `${m.requirementId} supporting ${s.atomId}`,
              id: s.atomId,
            })),
            knownIds,
          ),
          ...checkQuotes(
            [
              ...m.supporting.map((s) => ({
                path: `${m.requirementId} supporting ${s.atomId}`,
                quote: s.quote,
              })),
              ...m.counter.map((c, i) => ({
                path: `${m.requirementId} counter ${i}`,
                quote: c.quote,
              })),
            ],
            candidateSource,
          ),
        ]),
      ];
    },
  });

  const byId = new Map(value.object.matches.map((m) => [m.requirementId, m]));
  return requirements.map((r) => ({
    // A dropped requirement scores 0 rather than vanishing: a missing row would
    // silently shrink the denominator and inflate the percentage.
    match: byId.get(r.id) ?? {
      requirementId: r.id,
      level: 0 as const,
      supporting: [],
      counter: [],
      reasoning: "This requirement was not scored. Treating it as unevidenced.",
      confidence: "low" as const,
    },
    modelSpec: value.modelSpec,
    issues: byId.has(r.id) ? issues : [],
  }));
}

export async function matchAll(args: {
  target: JobTarget;
  profile: CandidateProfile;
  candidateSource: string;
}) {
  const scored = args.target.requirements.filter(
    (r) => r.kind !== "eligibility",
  );
  if (!scored.length) return [];

  // Default stays one-per-requirement until the eval set says otherwise. The
  // batch alternative is cheaper; whether it is as honest is measurable, not
  // arguable. MATCH_STRATEGY=batch to compare.
  if (process.env.MATCH_STRATEGY === "batch") {
    return matchBatch({ ...args, requirements: scored });
  }

  // The first call runs alone so it can write the shared prompt-cache prefix;
  // the rest then read it instead of each paying to rewrite it.
  const [first, ...rest] = scored;
  const head = await matchRequirement({ ...args, requirement: first! });
  const tail = await pooled(rest, concurrency(), (requirement) =>
    matchRequirement({ ...args, requirement }),
  );
  return [head, ...tail];
}
