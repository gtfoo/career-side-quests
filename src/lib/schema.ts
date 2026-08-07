import { z } from "zod";

/**
 * The contract every pipeline stage speaks.
 *
 * Two things here are load-bearing and should not be relaxed:
 *
 *  - Every model-produced claim carries a `quote` that must appear VERBATIM in
 *    its source. That turns hallucination into a cheap string check
 *    (see pipeline/validate.ts) instead of a matter of trust.
 *  - No stage emits an overall score. Levels are per-requirement; the number is
 *    computed in TypeScript (see pipeline/aggregate.ts). A model asked for a
 *    percentage will produce a plausible one regardless of the evidence.
 */

// ---------------------------------------------------------------- the target

/**
 * How much we actually know about the role. Shown to the user, because a read
 * built from a live posting and one built from a job title are not the same
 * claim, and pretending otherwise is how these tools lose trust.
 */
export const Fidelity = z.enum([
  "posting", // a specific live posting — sharpest
  "pasted", // JD text the user pasted
  "company_role", // role at a named company, aggregated from their postings
  "market_role", // role only, aggregated across the market — roughest
]);
export type Fidelity = z.infer<typeof Fidelity>;

export const RequirementKind = z.enum([
  "hard_skill",
  "tool",
  "domain",
  "seniority",
  "soft_skill",
  "credential",
  "language",
  "eligibility", // work authorisation, location, clearance — a GATE, not a score
]);

export const Requirement = z.object({
  id: z.string().describe("Stable short id, e.g. R1"),
  text: z.string().describe("The requirement, in plain words"),
  quote: z
    .string()
    .describe("Verbatim span from the job description that states this"),
  kind: RequirementKind,
  mustHave: z.boolean().describe("Stated as required rather than preferred"),
  weight: z
    .number()
    .min(1)
    .max(5)
    .describe("How much this drives the hiring decision, 1-5"),
});
export type Requirement = z.infer<typeof Requirement>;

export const JobTarget = z.object({
  title: z.string(),
  company: z.string().nullable(),
  team: z.string().nullable(),
  locations: z.array(z.string()),
  remote: z.boolean().nullable(),
  // Bounded so the scoring denominator cannot drift far between runs. The
  // prompt asks for 8-10; these are the hard rails either side of that.
  requirements: z.array(Requirement).min(6).max(12),
});
export type JobTarget = z.infer<typeof JobTarget>;

// -------------------------------------------------------------- the evidence

export const EvidenceKind = z.enum([
  "role", // a job held
  "achievement", // something shipped or delivered
  "skill_claim", // self-asserted, no artifact — weakest kind
  "artifact", // a repo, product, publication — strongest kind
  "credential",
  "language",
  "education",
]);

export const EvidenceAtom = z.object({
  id: z.string().describe("Stable short id, e.g. E1"),
  kind: EvidenceKind,
  summary: z.string().describe("What this shows, in plain words"),
  quote: z
    .string()
    .describe("Verbatim span from the candidate's own material"),
  sourceId: z.string().describe("Which source document this came from"),
  when: z
    .string()
    .nullable()
    .describe("Rough period if stated, e.g. '2022-2024'"),
});
export type EvidenceAtom = z.infer<typeof EvidenceAtom>;

export const CandidateProfile = z.object({
  name: z.string().nullable(),
  location: z.string().nullable(),
  workAuth: z
    .array(z.string())
    .describe("Citizenships/permits if stated, for the eligibility gate"),
  atoms: z.array(EvidenceAtom),
});
export type CandidateProfile = z.infer<typeof CandidateProfile>;

// --------------------------------------------------------------- the scoring

/**
 * 0 = nothing at all, 1 = self-asserted only, 2 = role implies it,
 * 3 = a specific named artifact or outcome demonstrates it.
 *
 * Expressed as a bounded integer rather than a union of numeric literals.
 * Gemini's structured-output schema rejects non-string enum values outright
 * ("Invalid value at ...enum[0] (TYPE_STRING), 0"), so the literal union made
 * this stage impossible to run there — which broke fallback exactly when it
 * was needed most, with the two paid providers already exhausted.
 */
export const Level = z.number().int().min(0).max(3);

export const RequirementMatch = z.object({
  requirementId: z.string(),
  level: Level,
  /** Evidence that supports the level. Empty at level 0. */
  supporting: z
    .array(
      z.object({
        atomId: z.string(),
        quote: z.string().describe("Verbatim span from the candidate material"),
      }),
    )
    .max(3),
  /**
   * Evidence that CUTS AGAINST the claim — a skills line with no artifact, a
   * repo in the wrong language. Required because models flatter resumes by
   * default; making the absence explicit is what makes the level honest.
   */
  counter: z
    .array(
      z.object({
        observation: z.string(),
        quote: z.string().nullable(),
      }),
    )
    .max(2),
  reasoning: z
    .string()
    .describe("One or two sentences, addressed to the candidate"),
  confidence: z.enum(["low", "medium", "high"]),
});
export type RequirementMatch = z.infer<typeof RequirementMatch>;

// --------------------------------------------------------------- the outputs

/** How far this move is. Drives which outputs matter, not just the wording. */
export const Distance = z.enum(["D0", "D1", "D2", "D3", "D4"]);
export type Distance = z.infer<typeof Distance>;

/** Headline call. The percentage is a supporting detail, never the headline. */
export const Verdict = z.enum(["lock", "stretch", "long_shot"]);
export type Verdict = z.infer<typeof Verdict>;

export const RemediationKind = z.enum([
  "rewrite", // they have it; the CV hides it
  "read", // small knowledge gap
  "drill", // needs reps, not a build
  "project", // genuine capability gap, buildable
  "cannot_shortcut", // years, tenure, headcount, clearance — say so plainly
]);

export const Gap = z.object({
  requirementId: z.string(),
  what: z.string(),
  why: z.string(),
  kind: RemediationKind,
  effortHours: z
    .number()
    .nullable()
    .describe("null when the gap cannot be shortcut"),
  /** blocking x cheapness — used to show only the few that matter */
  priority: z.number().min(0).max(100),
});
export type Gap = z.infer<typeof Gap>;

// ---------------------------------------------------------- the side quest

/**
 * One scoped build that closes one gap.
 *
 * The schema is strict on purpose. A free-text brief cannot be checked, and
 * an unchecked brief is where this feature quietly turns into "build a todo
 * app" — generic, ungrounded, and useless. Every field below either cites
 * something real or is arithmetic a validator can verify (pipeline/quest.ts).
 */
export const Milestone = z.object({
  id: z.string(),
  title: z.string(),
  hours: z.number().min(0.5).max(20),
  /** Binary and self-checkable. "Works well" is not an acceptance criterion. */
  acceptance: z.array(z.string()).min(1).max(3),
  /**
   * True for the minimum shippable set. This is what stops a "weekend project"
   * quietly becoming sixty hours — everything before the cut line must sum to
   * no more than 60% of the budget.
   */
  beforeCutLine: z.boolean(),
});
export type Milestone = z.infer<typeof Milestone>;

export const ProjectBrief = z.object({
  title: z.string(),
  /** Why this build, in terms of what it moves. */
  proves: z
    .array(
      z.object({
        requirementId: z.string(),
        jdQuote: z.string().describe("Verbatim span from the job description"),
        from: Level,
        to: Level,
      }),
    )
    .min(1)
    .max(3),
  /** Grounded in their own material, so the brief is theirs and not generic. */
  youAlreadyHave: z
    .array(
      z.object({
        what: z.string(),
        evidenceQuote: z
          .string()
          .describe("Verbatim span from the candidate's material"),
      }),
    )
    .max(4),
  /** Max two. More than two new things is a course, not a project. */
  theStretch: z.array(z.string()).min(1).max(2),
  timeBudget: z.object({
    totalHours: z.number().min(2).max(40),
    sessions: z.number().min(1).max(6),
  }),
  milestones: z.array(Milestone).min(2).max(6),
  proofArtifacts: z
    .array(z.enum(["repo", "readme", "deployed-url", "demo-video", "design-doc", "written-case"]))
    .min(1),
  /**
   * Metrics MUST be {{placeholders}}. The app does not know what the candidate
   * achieved, and inventing a number for someone's CV is the fastest way to
   * make them lie in an interview.
   */
  resumeBullets: z.array(z.string()).min(1).max(3),
  talkTrack: z.object({
    pitch: z.string(),
    likelyFollowUps: z.array(z.string()).min(1).max(3),
  }),
  /** What this does NOT demonstrate. Stated, not implied. */
  honestLimits: z.string(),
});
export type ProjectBrief = z.infer<typeof ProjectBrief>;

export const Assessment = z.object({
  distance: Distance,
  verdict: Verdict,
  carriesOver: z.number().min(0).max(100),
  eligibility: z.object({
    clear: z.boolean(),
    note: z.string().nullable(),
  }),
  matches: z.array(RequirementMatch),
  gaps: z.array(Gap),
});
export type Assessment = z.infer<typeof Assessment>;
