import { NextResponse } from "next/server";
import { snapshotFromPaste, type PostingSnapshot } from "@/lib/ingest/posting";
import { fromPlainText } from "@/lib/ingest/resume";
import { runRead } from "@/lib/pipeline/assess";

/**
 * Run a full read.
 *
 * Takes the already-ingested snapshot and parsed documents from the client
 * rather than re-fetching: the snapshot is the thing every quote is checked
 * against, so it must be the exact text the user saw us capture.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json()) as {
    snapshot?: PostingSnapshot;
    docs?: { id: string; text: string }[];
    notes?: string;
  };

  if (!body.snapshot?.text) {
    return NextResponse.json(
      { ok: false, message: "No job description to read against." },
      { status: 400 },
    );
  }
  if (!body.docs?.length) {
    return NextResponse.json(
      { ok: false, message: "No candidate material to read." },
      { status: 400 },
    );
  }

  try {
    const result = await runRead({
      snapshot: body.snapshot.text
        ? body.snapshot
        : snapshotFromPaste(body.snapshot.text),
      docs: body.docs.map((d) => fromPlainText(d.text, d.id)),
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A missing key is the most likely failure on a fresh clone, so say that
    // plainly instead of surfacing a provider SDK's internals.
    // Note the hyphen: providers say "invalid x-api-key", not "invalid api key".
    const friendly = /api[-_ ]?key|credential|unauthor|authentication|401|403/i.test(
      message,
    )
      ? "That model API key was rejected. Put a real key in .env.local (ANTHROPIC_API_KEY) and restart the dev server — the placeholder won't work."
      : message;
    return NextResponse.json({ ok: false, message: friendly }, { status: 500 });
  }
}
