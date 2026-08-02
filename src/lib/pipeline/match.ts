import { generate } from "@/lib/llm";
import {
  RequirementMatch,
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

  const { value, issues } = await withValidation({
    label: `match:${requirement.id}`,
    attempt: async (feedback) =>
      generate({
        stage: "match",
        schema: RequirementMatch,
        system: MATCH_SYSTEM,
        prompt: [
          feedback,
          `Role: ${target.title}${target.company ? ` at ${target.company}` : ""}`,
          "",
          `Requirement ${requirement.id} (${requirement.kind}, ${
            requirement.mustHave ? "required" : "preferred"
          }):`,
          requirement.text,
          `Stated in the posting as: "${requirement.quote}"`,
          "",
          "Candidate evidence:",
          renderEvidence(profile),
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
export async function matchAll(args: {
  target: JobTarget;
  profile: CandidateProfile;
  candidateSource: string;
}) {
  const scored = args.target.requirements.filter(
    (r) => r.kind !== "eligibility",
  );
  if (!scored.length) return [];

  const [first, ...rest] = scored;
  const head = await matchRequirement({ ...args, requirement: first! });
  const tail = await Promise.all(
    rest.map((requirement) => matchRequirement({ ...args, requirement })),
  );
  return [head, ...tail];
}
