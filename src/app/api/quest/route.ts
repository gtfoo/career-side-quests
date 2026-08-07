import { NextResponse } from "next/server";
import { LIMITS, check, clientKey, tooMany } from "@/lib/ratelimit";
import { generateBrief } from "@/lib/pipeline/quest";
import type {
  CandidateProfile,
  Gap,
  JobTarget,
  RequirementMatch,
} from "@/lib/schema";

/**
 * Generate one side quest, on demand.
 *
 * Lazily, per gap, when the user asks — not upfront for every gap in a read.
 * Most gaps never get opened, this is the most expensive stage in the pipeline
 * (xhigh effort), and pre-generating six briefs to have five ignored is the
 * kind of waste that only shows up on the bill.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  const rate = check(clientKey(request, "assess"), LIMITS.assess);
  if (!rate.ok) return tooMany(rate, "requests");

  const body = (await request.json()) as {
    gap?: Gap;
    target?: JobTarget;
    profile?: CandidateProfile;
    matches?: RequirementMatch[];
    candidateText?: string;
    jdText?: string;
  };

  const { gap, target, profile } = body;
  if (!gap || !target || !profile) {
    return NextResponse.json(
      { ok: false, message: "Missing the gap, the role, or your evidence." },
      { status: 400 },
    );
  }

  const requirement = target.requirements.find(
    (r) => r.id === gap.requirementId,
  );
  if (!requirement) {
    return NextResponse.json(
      { ok: false, message: "That gap doesn't match anything in the posting." },
      { status: 400 },
    );
  }

  try {
    const out = await generateBrief({
      gap,
      requirement,
      match: body.matches?.find((m) => m.requirementId === gap.requirementId),
      target,
      profile,
      candidateText: body.candidateText ?? "",
      jdText: body.jdText ?? "",
    });
    return NextResponse.json({
      ok: true,
      brief: out.brief,
      flags: out.issues.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const friendly = /SpendBlocked|Blocked before calling a model/i.test(message)
      ? "Model calls are switched off. Set LLM_SPEND=allow and restart."
      : /credit|quota|insufficient|billing|exhausted/i.test(message)
        ? "Every configured provider is out of credit or quota."
        : message;
    return NextResponse.json({ ok: false, message: friendly }, { status: 500 });
  }
}
