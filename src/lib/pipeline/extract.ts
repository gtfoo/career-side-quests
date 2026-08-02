import { generate } from "@/lib/llm";
import { CandidateProfile, JobTarget } from "@/lib/schema";
import type { PostingSnapshot } from "@/lib/ingest/posting";
import type { SourceDoc } from "@/lib/ingest/resume";
import { checkQuotes, withValidation } from "./validate";

/**
 * Stage 1 and 2: turn a job description and a pile of candidate material into
 * structured, individually-quoted facts.
 *
 * These run as separate passes on purpose. Extracting both sides in one call
 * lets the model see the answer while deciding what the question is, and it
 * quietly bends requirements toward whatever the candidate happens to have.
 */

const JD_SYSTEM = `You extract the real hiring bar from a job description.

Rules:
- Every requirement must carry a "quote" copied EXACTLY from the description, character for character. If you cannot quote it, do not list it.
- Extract what is actually being screened for, not the marketing. Skip perks, company blurb, and DEI boilerplate.
- Distinguish required from preferred. "Must", "required", years of experience and named languages are usually required; "bonus", "nice to have", "a plus" are not.
- Weight 1-5 by how much the requirement drives the hiring decision, not how prominently it appears.
- Mark work authorisation, location and clearance as kind "eligibility". These gate the application; they are not skills.

Merging, which decides how many requirements you end up with:
- Two requirements that the SAME piece of a candidate's experience would satisfy are ONE requirement. Merge them and quote the stronger line.
- Split only when a candidate could plausibly have one and not the other.
- Soft qualities stated several ways ("empathy for customers", "enjoys working
  with customers", "customer-focused") are one requirement, not three.
- Produce 8 to 10 requirements. Fewer means you have merged things a candidate
  could hold separately; more means you are listing phrasings rather than
  requirements.`;

export async function extractJobTarget(snapshot: PostingSnapshot) {
  const known = snapshot.text;

  const { value, issues } = await withValidation({
    label: "extract_jd",
    attempt: async (feedback) => {
      const res = await generate({
        stage: "extract_jd",
        schema: JobTarget,
        system: JD_SYSTEM,
        prompt: [
          feedback,
          "Job description:",
          "---",
          snapshot.text,
          "---",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      return res;
    },
    validate: (res) =>
      checkQuotes(
        res.object.requirements.map((r) => ({
          path: `requirement ${r.id}`,
          quote: r.quote,
        })),
        known,
      ),
  });

  return { target: value.object, modelSpec: value.modelSpec, issues };
}

const EVIDENCE_SYSTEM = `You extract evidence from a candidate's own materials.

Rules:
- Every atom must carry a "quote" copied EXACTLY from the source, character for character.
- Classify honestly. A line in a skills list is kind "skill_claim" — self-asserted with nothing attached. A shipped product, repository or publication is kind "artifact". Do not promote a claim to an artifact because it sounds impressive.
- Capture things that look irrelevant to any particular job. Someone changing field often has their strongest evidence in work they think no longer counts.
- Record stated citizenship, visa or work permit exactly as written, for the eligibility check.
- Do not infer, embellish, or fill gaps. Extract only what is on the page.`;

export async function extractCandidate(docs: SourceDoc[], extraNotes?: string) {
  const corpus = docs
    .map((d) => `### source: ${d.id}\n${d.text}`)
    .join("\n\n");
  // Things the user typed about themselves are evidence too — and for career
  // changers they are often the ONLY record of their previous life, because
  // people delete it from their CV precisely when it matters most.
  const withNotes = extraNotes
    ? `${corpus}\n\n### source: notes\n${extraNotes}`
    : corpus;

  const { value, issues } = await withValidation({
    label: "extract_evidence",
    attempt: async (feedback) =>
      generate({
        stage: "extract_evidence",
        schema: CandidateProfile,
        system: EVIDENCE_SYSTEM,
        prompt: [feedback, "Candidate materials:", "---", withNotes, "---"]
          .filter(Boolean)
          .join("\n"),
      }),
    validate: (res) =>
      checkQuotes(
        res.object.atoms.map((a) => ({
          path: `atom ${a.id}`,
          quote: a.quote,
        })),
        withNotes,
      ),
  });

  return { profile: value.object, modelSpec: value.modelSpec, issues };
}
