import { NextResponse } from "next/server";
import { coverageNotice, extractDocument } from "@/lib/ingest/resume";

/**
 * Parse an uploaded CV and report how much of it was actually readable.
 *
 * The coverage number is the point. A CV that silently yields one page of
 * fourteen would otherwise be scored as if that were the whole person — so the
 * response always carries what was read, what was not, and why.
 *
 * Nothing is written to disk. Resumes are PII and this app has no reason to
 * keep one after the read.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, message: "No file received." },
      { status: 400 },
    );
  }

  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json(
      { ok: false, message: "That file is over 20MB. Export a smaller copy." },
      { status: 413 },
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await extractDocument(bytes, file.name);

    return NextResponse.json({
      ok: true,
      doc: {
        id: doc.id,
        filename: doc.filename,
        pages: doc.pages.length,
        coverage: doc.coverage,
        needsVision: doc.needsVision,
        chars: doc.text.length,
        notice: coverageNotice(doc),
        text: doc.text,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : "Could not read that file. Try a PDF, DOCX, or paste the text.",
      },
      { status: 400 },
    );
  }
}
