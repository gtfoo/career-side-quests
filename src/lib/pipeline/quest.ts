import { generate } from "@/lib/llm";
import {
  ProjectBrief,
  type CandidateProfile,
  type Gap,
  type JobTarget,
  type Requirement,
  type RequirementMatch,
} from "@/lib/schema";
import {
  checkQuotes,
  hasFabricatedMetric,
  withValidation,
  type ValidationIssue,
} from "./validate";

/**
 * Turn one gap into one buildable thing.
 *
 * The generator takes three inputs, not one, and the third is what stops this
 * producing slop:
 *
 *   1. the gap — which requirement, at what level, and why it fell short
 *   2. the candidate's own evidence — so the brief builds on what they have
 *      rather than starting from nothing
 *   3. the posting's own words — so what it proves is quoted, not asserted
 *
 * The slop test to hold this to: swap in a different candidate against the same
 * posting and the brief should change substantially. If it doesn't, the
 * generator is ignoring input 2 and writing a generic tutorial.
 */

const QUEST_SYSTEM = `You design ONE small project that closes ONE specific gap for ONE specific person.

The reader is mid-career and busy. They will not do a course. They will build
something over a weekend if — and only if — it is obviously worth it and
obviously finishable.

Rules that decide whether this is useful or noise:

- BUILD ON WHAT THEY HAVE. If they have shipped something, extend it. A brief
  that ignores their existing work is a generic tutorial with their name on it.
  Quote their material verbatim in "youAlreadyHave".
- AT MOST TWO NEW THINGS in "theStretch". More than two is a course.
- Quote the job description verbatim in "proves". If you cannot quote it, this
  project does not prove it.
- Milestones are ordered, and the early ones marked beforeCutLine must be a
  COMPLETE, SHIPPABLE THING on their own. Everything after is optional polish.
  The cut-line set must be well under half the total hours.
- Acceptance criteria are binary and self-checkable. "Handles errors well" is
  not one. "Returns a message instead of crashing when the API 500s" is.
- NEVER invent a number. Resume bullets must write metrics as {{placeholder}},
  e.g. "cut latency by {{n}}%". You do not know what they achieved.
- "honestLimits" must name what this genuinely does NOT demonstrate. A brief
  that claims to prove everything proves nothing.

Write to the candidate, in second person. Be concrete: name files, endpoints,
tools. Vague briefs do not get built.`;

function renderEvidence(profile: CandidateProfile): string {
  return profile.atoms
    .map((a) => `[${a.id}] (${a.kind}) ${a.summary}\n    "${a.quote}"`)
    .join("\n");
}

/**
 * Checks that need no model and no judgement. These are what make a brief
 * trustworthy rather than merely well-written — every one of them was a way
 * the output could look right and be wrong.
 */
export function checkBrief(
  brief: ProjectBrief,
  sources: { jdText: string; candidateText: string },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...checkQuotes(
      brief.proves.map((p) => ({
        path: `proves ${p.requirementId}`,
        quote: p.jdQuote,
      })),
      sources.jdText,
    ),
    ...checkQuotes(
      brief.youAlreadyHave.map((y, i) => ({
        path: `youAlreadyHave[${i}]`,
        quote: y.evidenceQuote,
      })),
      sources.candidateText,
    ),
  ];

  // A "12 hour" project whose milestones sum to 30 is a lie about scope, and
  // scope is the thing the reader is deciding on.
  const summed = brief.milestones.reduce((n, m) => n + m.hours, 0);
  const budget = brief.timeBudget.totalHours;
  if (Math.abs(summed - budget) > budget * 0.2) {
    issues.push({
      path: "timeBudget",
      problem: `milestones sum to ${summed}h but the budget says ${budget}h`,
    });
  }

  // The cut line only means something if shipping early is genuinely lighter.
  const beforeCut = brief.milestones
    .filter((m) => m.beforeCutLine)
    .reduce((n, m) => n + m.hours, 0);
  if (beforeCut > summed * 0.6) {
    issues.push({
      path: "cutLine",
      problem: `the shippable set is ${Math.round((beforeCut / summed) * 100)}% of the work; it must be 60% or less`,
    });
  }
  if (beforeCut === 0) {
    issues.push({
      path: "cutLine",
      problem: "no milestone is marked beforeCutLine, so there is nothing to ship early",
    });
  }

  // The single most damaging failure mode: a plausible number on someone's CV.
  for (const [i, bullet] of brief.resumeBullets.entries()) {
    if (hasFabricatedMetric(bullet)) {
      issues.push({
        path: `resumeBullets[${i}]`,
        problem: "contains a number that is not a {{placeholder}}",
        detail: bullet.slice(0, 100),
      });
    }
  }

  // A brief that only ever moves things upward is flattery.
  for (const p of brief.proves) {
    if (p.to <= p.from) {
      issues.push({
        path: `proves ${p.requirementId}`,
        problem: `claims to move level ${p.from} to ${p.to}`,
      });
    }
  }

  return issues;
}

export async function generateBrief(args: {
  gap: Gap;
  requirement: Requirement;
  match: RequirementMatch | undefined;
  target: JobTarget;
  profile: CandidateProfile;
  candidateText: string;
  jdText: string;
}) {
  const { gap, requirement, match, target, profile } = args;

  const { value, issues } = await withValidation({
    label: `quest:${requirement.id}`,
    maxAttempts: 2,
    attempt: async (feedback) =>
      generate({
        stage: "quest",
        schema: ProjectBrief,
        system: QUEST_SYSTEM,
        isRetry: Boolean(feedback),
        prompt: [
          feedback,
          `Role: ${target.title}${target.company ? ` at ${target.company}` : ""}`,
          "",
          `The gap to close — requirement ${requirement.id} (${requirement.kind}):`,
          requirement.text,
          `The posting says: "${requirement.quote}"`,
          `They currently score ${match?.level ?? 0}/3. ${match?.reasoning ?? ""}`,
          "",
          "Everything they already have:",
          renderEvidence(profile),
          "",
          `Budget: about ${gap.effortHours ?? 12} hours.`,
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    validate: (res) =>
      checkBrief(res.object, {
        jdText: args.jdText,
        candidateText: args.candidateText,
      }),
  });

  return { brief: value.object, modelSpec: value.modelSpec, issues };
}
