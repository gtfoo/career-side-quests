import type {
  Distance,
  JobTarget,
  RequirementMatch,
  Verdict,
} from "@/lib/schema";

/**
 * Scoring happens HERE, in code — no model is ever asked for a percentage.
 *
 * Ask a model for a score and it returns a plausible-looking number that moves
 * when you rephrase the prompt. Ask it for per-requirement levels with quoted
 * evidence and do the arithmetic yourself, and the number moves only when the
 * evidence does. That is the difference between a score you can defend and one
 * you cannot.
 */

/** Must-haves dominate. A missing nice-to-have should barely register. */
const MUST_HAVE_MULTIPLIER = 2;

export type Scored = {
  /** How much of what the role needs the candidate already has, 0-100. */
  carriesOver: number;
  verdict: Verdict;
  distance: Distance;
  /** Requirement ids sorted by how much closing them would move the score. */
  decisive: string[];
};

function weightOf(req: { mustHave: boolean; weight: number }): number {
  return req.weight * (req.mustHave ? MUST_HAVE_MULTIPLIER : 1);
}

/**
 * Weighted fraction of the role's requirements that are evidenced.
 * Eligibility requirements are EXCLUDED — they are a gate, not a score. Folding
 * "cannot legally work here" into a capability percentage produces a number
 * that is wrong in both directions at once.
 */
export function scoreCarryOver(
  target: JobTarget,
  matches: RequirementMatch[],
): number {
  const byId = new Map(matches.map((m) => [m.requirementId, m]));
  const scored = target.requirements.filter((r) => r.kind !== "eligibility");
  if (!scored.length) return 0;

  let earned = 0;
  let available = 0;
  for (const req of scored) {
    const w = weightOf(req);
    available += w * 3; // 3 == fully demonstrated
    earned += w * (byId.get(req.id)?.level ?? 0);
  }
  return Math.round((earned / available) * 100);
}

/**
 * The headline is a word, not a number.
 *
 * A single unmet must-have caps the verdict at "stretch" no matter how high the
 * percentage: 90% with the one required thing missing is not a lock, and
 * telling someone otherwise sets them up to be screened out.
 */
export function verdictFor(
  target: JobTarget,
  matches: RequirementMatch[],
  carriesOver: number,
): Verdict {
  const byId = new Map(matches.map((m) => [m.requirementId, m]));
  const unmetMustHaves = target.requirements.filter(
    (r) =>
      r.mustHave &&
      r.kind !== "eligibility" &&
      (byId.get(r.id)?.level ?? 0) <= 1,
  ).length;

  if (carriesOver >= 80 && unmetMustHaves === 0) return "lock";
  if (carriesOver >= 45 && unmetMustHaves <= 2) return "stretch";
  return "long_shot";
}

/**
 * Distance is measured, not assumed, so the same pipeline can serve a sideways
 * move and a career change. It decides which outputs carry the page: near, the
 * gap list and the build; far, the translation and the staged route.
 */
export function distanceFor(args: {
  sameFunction: boolean;
  sameIndustry: boolean;
  /** Fraction of DOMAIN requirements with real evidence, 0-1. */
  domainOverlap: number;
}): Distance {
  const { sameFunction, sameIndustry, domainOverlap } = args;
  if (sameFunction && sameIndustry) return "D0";
  if (sameFunction && !sameIndustry) return "D1";
  if (!sameFunction && sameIndustry) return "D2";
  // Neither matches: how gettable it is depends on whether anything transfers.
  return domainOverlap < 0.25 ? "D4" : "D3";
}

/**
 * Which gaps actually decide the outcome: heavy, required, and far from met.
 * Used to show two or three and say plainly that the rest are being ignored —
 * an honest list of twelve is the same as no list.
 */
export function decisiveRequirements(
  target: JobTarget,
  matches: RequirementMatch[],
): string[] {
  const byId = new Map(matches.map((m) => [m.requirementId, m]));
  return target.requirements
    .filter((r) => r.kind !== "eligibility")
    .map((r) => {
      const level = byId.get(r.id)?.level ?? 0;
      return { id: r.id, impact: weightOf(r) * (3 - level) };
    })
    .filter((r) => r.impact > 0)
    .sort((a, b) => b.impact - a.impact)
    .map((r) => r.id);
}

export function aggregate(args: {
  target: JobTarget;
  matches: RequirementMatch[];
  sameFunction: boolean;
  sameIndustry: boolean;
  domainOverlap: number;
}): Scored {
  const carriesOver = scoreCarryOver(args.target, args.matches);
  return {
    carriesOver,
    verdict: verdictFor(args.target, args.matches, carriesOver),
    distance: distanceFor(args),
    decisive: decisiveRequirements(args.target, args.matches),
  };
}
