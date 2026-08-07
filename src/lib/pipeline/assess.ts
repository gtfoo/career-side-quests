import type { PostingSnapshot } from "@/lib/ingest/posting";
import type { SourceDoc } from "@/lib/ingest/resume";
import type {
  Assessment,
  CandidateProfile,
  Gap,
  JobTarget,
  RequirementMatch,
} from "@/lib/schema";
import { aggregate } from "./aggregate";
import { extractCandidate, extractJobTarget } from "./extract";
import { matchAll } from "./match";

/**
 * The whole read, start to finish.
 *
 * Order matters: requirements are extracted BEFORE the candidate is looked at,
 * and the candidate is extracted without sight of the requirements. Doing
 * either the other way round lets the bar bend toward whatever the person
 * happens to have.
 */

export type ReadResult = {
  target: JobTarget;
  assessment: Assessment;
  /** Surfaced so the UI can show which model produced what. */
  models: Record<string, string>;
  /** Ungrounded claims that survived retries. Shown, never hidden. */
  flags: { stage: string; problem: string }[];
  fidelity: PostingSnapshot["fidelity"];
  capturedAt: string;
  /**
   * Carried through so a side quest can be built later without re-running
   * extraction, and so its quotes are checked against the same sources this
   * read was scored against.
   */
  profile: CandidateProfile;
  candidateText: string;
  jdText: string;
};

/**
 * Eligibility is answered from stated facts, not inferred. If the posting names
 * locations and the candidate states a citizenship or permit, we can say
 * something useful; otherwise we say we don't know rather than guessing at
 * someone's right to work.
 */
function checkEligibility(target: JobTarget, workAuth: string[]) {
  const reqs = target.requirements.filter((r) => r.kind === "eligibility");
  if (!reqs.length || !target.locations.length) {
    return { clear: true, note: null };
  }
  if (!workAuth.length) {
    return {
      clear: true,
      note: "This posting has location or work-authorisation conditions. Your CV doesn't state yours, so this hasn't been checked.",
    };
  }
  const auth = workAuth.join(" ").toLowerCase();
  const hit = target.locations.find((loc) => {
    const l = loc.toLowerCase();
    return auth.includes(l) || l.split(/[,()]/).some((p) => auth.includes(p.trim()) && p.trim().length > 3);
  });
  return hit
    ? { clear: true, note: `You're eligible for the ${hit} location.` }
    : {
        clear: false,
        note: `This role is based in ${target.locations.join(", ")}. Nothing on your CV shows the right to work there — worth confirming before you spend effort on the gaps below.`,
      };
}

/**
 * Turn scored requirements into a ranked, routed gap list.
 *
 * The routing is the honest part: most gaps do NOT deserve a project. A gap the
 * candidate already meets but has phrased badly is a ten-minute rewrite, and a
 * gap that needs years cannot be shortcut at all — saying so is what makes the
 * rest of the list credible.
 */
export function deriveGaps(
  target: JobTarget,
  matches: RequirementMatch[],
): Gap[] {
  const byId = new Map(matches.map((m) => [m.requirementId, m]));

  return target.requirements
    .filter((r) => r.kind !== "eligibility")
    .map((req): Gap | null => {
      const m = byId.get(req.id);
      const level = m?.level ?? 0;
      if (level >= 3) return null;

      const weight = req.weight * (req.mustHave ? 2 : 1);
      // Distance from met, scaled by how much the requirement matters.
      const priority = Math.min(100, Math.round((weight * (3 - level) * 100) / 30));

      let kind: Gap["kind"];
      let effortHours: number | null;

      // Attributes, not skills. Years of experience, a degree, a certification
      // and a language are all things no weekend project produces — and a
      // brief that pretends otherwise is worse than no brief. This is a second
      // guard on purpose: even when scoring gets a level wrong, nothing here
      // should propose building your way to being bilingual.
      if (
        req.kind === "seniority" ||
        req.kind === "credential" ||
        req.kind === "language"
      ) {
        kind = "cannot_shortcut";
        effortHours = null;
      } else if (level === 2) {
        // Nearly there: usually a framing problem rather than a capability one.
        kind = "rewrite";
        effortHours = 0.25;
      } else if (req.kind === "soft_skill" || req.kind === "domain") {
        kind = "read";
        effortHours = 1;
      } else {
        kind = "project";
        effortHours = 12;
      }

      return {
        requirementId: req.id,
        what: req.text,
        why: m?.reasoning ?? "No evidence found for this.",
        kind,
        effortHours,
        priority,
      };
    })
    .filter((g): g is Gap => g !== null)
    .sort((a, b) => b.priority - a.priority);
}

export async function runRead(args: {
  snapshot: PostingSnapshot;
  docs: SourceDoc[];
  notes?: string;
  /** Set when the user tells us; otherwise inferred conservatively. */
  sameFunction?: boolean;
  sameIndustry?: boolean;
}): Promise<ReadResult> {
  const { snapshot, docs, notes } = args;
  const flags: ReadResult["flags"] = [];
  const models: Record<string, string> = {};

  const jd = await extractJobTarget(snapshot);
  models.extract_jd = jd.modelSpec;
  for (const i of jd.issues) {
    flags.push({ stage: "job description", problem: `${i.path}: ${i.problem}` });
  }

  const ev = await extractCandidate(docs, notes);
  models.extract_evidence = ev.modelSpec;
  for (const i of ev.issues) {
    flags.push({ stage: "your materials", problem: `${i.path}: ${i.problem}` });
  }

  const candidateSource = [
    ...docs.map((d) => d.text),
    notes ?? "",
  ].join("\n\n");

  const results = await matchAll({
    target: jd.target,
    profile: ev.profile,
    candidateSource,
  });
  const matches = results.map((r) => r.match);
  if (results[0]) models.match = results[0].modelSpec;
  for (const r of results) {
    for (const i of r.issues) {
      flags.push({
        stage: `requirement ${r.match.requirementId}`,
        problem: `${i.path}: ${i.problem}`,
      });
    }
  }

  // Domain overlap drives the distance band, so it is measured from the domain
  // requirements specifically rather than from the overall score.
  const domainReqs = jd.target.requirements.filter((r) => r.kind === "domain");
  const byId = new Map(matches.map((m) => [m.requirementId, m]));
  const domainOverlap = domainReqs.length
    ? domainReqs.filter((r) => (byId.get(r.id)?.level ?? 0) >= 2).length /
      domainReqs.length
    : 0.5;

  const scored = aggregate({
    target: jd.target,
    matches,
    sameFunction: args.sameFunction ?? true,
    sameIndustry: args.sameIndustry ?? false,
    domainOverlap,
  });

  return {
    target: jd.target,
    assessment: {
      distance: scored.distance,
      verdict: scored.verdict,
      carriesOver: scored.carriesOver,
      eligibility: checkEligibility(jd.target, ev.profile.workAuth),
      matches,
      gaps: deriveGaps(jd.target, matches),
    },
    models,
    flags,
    fidelity: snapshot.fidelity,
    capturedAt: snapshot.capturedAt,
    profile: ev.profile,
    candidateText: candidateSource,
    jdText: snapshot.text,
  };
}
