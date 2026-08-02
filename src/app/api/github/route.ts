import { NextResponse } from "next/server";
import { readGithub } from "@/lib/ingest/github";

/**
 * Read a public GitHub profile as evidence.
 *
 * Returns the same SourceDoc shape as an uploaded CV, so the client can treat
 * it as one more document and the pipeline needs no special case for it.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json()) as { handle?: string };
  const handle = body.handle?.trim();

  if (!handle) {
    return NextResponse.json(
      { ok: false, message: "Give me a GitHub username or profile URL." },
      { status: 400 },
    );
  }

  const out = await readGithub(handle);
  if (!out.ok) {
    // 200: "I could not read that" is an expected outcome with a next step,
    // not a failure the user needs a red error for.
    return NextResponse.json({ ok: false, message: out.message });
  }

  return NextResponse.json({
    ok: true,
    doc: {
      id: out.doc.id,
      filename: out.doc.filename,
      pages: 1,
      coverage: 1,
      needsVision: [],
      chars: out.doc.text.length,
      notice: `${out.repoCount} original repositor${out.repoCount === 1 ? "y" : "ies"} read from github.com/${out.handle}`,
      text: out.doc.text,
    },
  });
}
