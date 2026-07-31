import { NextResponse } from "next/server";
import { fetchPosting, snapshotFromPaste } from "@/lib/ingest/posting";

/**
 * Resolve what the user is aiming at.
 *
 * A URL is tried against its board's API; anything else is treated as pasted
 * text. A failed fetch is NOT an error the user has to solve — it falls back to
 * paste, because the one input path that must never break is "I have the text".
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { url?: string; text?: string };

  if (body.text?.trim()) {
    return NextResponse.json({
      ok: true,
      snapshot: snapshotFromPaste(body.text),
    });
  }

  const url = body.url?.trim();
  if (!url) {
    return NextResponse.json(
      { ok: false, message: "Give me a posting link or paste the description." },
      { status: 400 },
    );
  }

  const out = await fetchPosting(url);
  if (out.ok) {
    return NextResponse.json({ ok: true, snapshot: out.snapshot });
  }

  // Deliberately 200: "I could not read that link" is an expected outcome with
  // a next step, not a failure state to show the user a red error for.
  return NextResponse.json({
    ok: false,
    reason: out.reason,
    message: out.message,
  });
}
