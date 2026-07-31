import { extractText, getDocumentProxy } from "unpdf";

/**
 * Turning whatever the user uploaded into text.
 *
 * This exists in its current shape because of a real failure: a 14-page CV
 * where only page 1 had a text layer. Text extraction returned zero characters
 * for pages 2-14 and reported no error at all. Scoring would have run on 7% of
 * the evidence and produced a confident, wrong answer.
 *
 * So the ladder is: try the cheap path, MEASURE PER PAGE, and escalate only the
 * pages that came back empty. A silent partial parse is the worst outcome this
 * app can have, which is why coverage is reported to the user rather than
 * swallowed.
 */

export type PageExtraction = {
  page: number;
  text: string;
  /** How the text was obtained. "none" means it needs a vision pass. */
  via: "text_layer" | "none";
};

export type SourceDoc = {
  id: string;
  filename: string;
  text: string;
  pages: PageExtraction[];
  /** Fraction of pages that yielded usable text, 0-1. */
  coverage: number;
  /** Pages needing a vision pass, 1-indexed. Empty when the file parsed fully. */
  needsVision: number[];
};

/**
 * Below this many characters a page is treated as empty. A scanned page often
 * yields a stray ligature or page number rather than literally nothing, so
 * zero is the wrong threshold.
 */
const MIN_CHARS_PER_PAGE = 40;

export async function extractPdf(
  bytes: Uint8Array,
  filename: string,
): Promise<SourceDoc> {
  const pdf = await getDocumentProxy(bytes);
  const { text: perPage } = await extractText(pdf, { mergePages: false });

  const pages: PageExtraction[] = perPage.map((raw, i) => {
    const text = (raw ?? "").trim();
    return {
      page: i + 1,
      text,
      via: text.length >= MIN_CHARS_PER_PAGE ? "text_layer" : "none",
    };
  });

  const usable = pages.filter((p) => p.via === "text_layer");
  return {
    id: filename,
    filename,
    text: usable.map((p) => p.text).join("\n\n"),
    pages,
    coverage: pages.length ? usable.length / pages.length : 0,
    needsVision: pages.filter((p) => p.via === "none").map((p) => p.page),
  };
}

export async function extractDocx(
  bytes: Uint8Array,
  filename: string,
): Promise<SourceDoc> {
  // Imported lazily: mammoth pulls in a large dependency tree and most uploads
  // are PDFs, so it should not be on the hot path.
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({
    buffer: Buffer.from(bytes),
  });
  const text = value.trim();
  return {
    id: filename,
    filename,
    text,
    pages: [{ page: 1, text, via: text ? "text_layer" : "none" }],
    coverage: text ? 1 : 0,
    needsVision: [],
  };
}

export function fromPlainText(text: string, label = "pasted"): SourceDoc {
  return {
    id: label,
    filename: label,
    text: text.trim(),
    pages: [{ page: 1, text: text.trim(), via: "text_layer" }],
    coverage: 1,
    needsVision: [],
  };
}

export async function extractDocument(
  bytes: Uint8Array,
  filename: string,
): Promise<SourceDoc> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return extractPdf(bytes, filename);
  if (lower.endsWith(".docx")) return extractDocx(bytes, filename);
  if (lower.endsWith(".txt") || lower.endsWith(".md")) {
    return fromPlainText(new TextDecoder().decode(bytes), filename);
  }
  throw new Error(
    `Unsupported file type: ${filename}. Upload a PDF, DOCX, or paste the text.`,
  );
}

/**
 * What to TELL the user about a partial parse. Phrased as something the app
 * noticed and can fix, not as their mistake — and never silent.
 */
export function coverageNotice(doc: SourceDoc): string | null {
  if (doc.needsVision.length === 0) return null;
  const total = doc.pages.length;
  const read = total - doc.needsVision.length;
  return `Read ${read} of ${total} pages of ${doc.filename}. The rest are images with no text layer — they need a second pass before they can count as evidence.`;
}
