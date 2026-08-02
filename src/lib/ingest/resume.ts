import { getDocumentProxy } from "unpdf";

/**
 * Turning whatever the user uploaded into text.
 *
 * Two real failures shaped this file, and both were silent:
 *
 * 1. A CV whose later pages had no text layer at all. Extraction returned zero
 *    characters and reported no error. So coverage is MEASURED PER PAGE and
 *    surfaced, never swallowed.
 *
 * 2. A two-column CV where extraction returned every word but destroyed the
 *    associations between them — all the language names, then all the
 *    proficiency levels, so "Mandarin Chinese / Native" was true on the page
 *    and absent from the text. Every quote citing it failed grounding, and the
 *    candidate was under-scored for their CV template. Multi-column CVs are
 *    extremely common, so extraction below is LAYOUT-AWARE: text items are
 *    grouped into visual rows and ordered left-to-right within each row.
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

/** A positioned run of text from the PDF's content stream. */
type Item = { str: string; x: number; y: number; w: number };

/**
 * Rebuild a page's reading order from item positions.
 *
 * pdfjs hands back text runs in content-stream order, which for a multi-column
 * layout means "everything in column one, then everything in column two". That
 * reads fine as prose and is wrong as data: a label in one column loses its
 * value in the other.
 *
 * So: group items into rows by y position, order each row by x, and insert a
 * wide gap where there is real horizontal space — which is what keeps
 * "Mandarin Chinese" attached to "Native / Bilingual" instead of stranding them
 * fifteen lines apart.
 */
function layoutText(items: Item[]): string {
  if (!items.length) return "";

  // Rows tolerate small vertical jitter: superscripts, differing font sizes and
  // baseline shifts should not each become their own line.
  const ROW_TOLERANCE = 3;
  const rows: Item[][] = [];

  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.y - item.y) <= ROW_TOLERANCE) row.push(item);
    else rows.push([item]);
  }

  return rows
    .map((row) => {
      const sorted = row.sort((a, b) => a.x - b.x);
      let line = "";
      let prevEnd: number | null = null;
      for (const it of sorted) {
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          // A gap wider than roughly a space is a column boundary or a tab
          // stop. Two spaces keeps it visible without inventing structure.
          line += gap > 12 ? "  " : gap > 1 ? " " : "";
        }
        line += it.str;
        prevEnd = it.x + it.w;
      }
      return line.trimEnd();
    })
    .filter((l) => l.trim().length > 0)
    .join("\n");
}

export async function extractPdf(
  bytes: Uint8Array,
  filename: string,
): Promise<SourceDoc> {
  const pdf = await getDocumentProxy(bytes);

  const pages: PageExtraction[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();

    const items: Item[] = content.items
      .filter((i): i is typeof i & { str: string } => "str" in i)
      .map((i) => {
        // transform is [a, b, c, d, e, f]; e/f are the x/y translation.
        const t = (i as unknown as { transform: number[] }).transform;
        return {
          str: i.str,
          x: t?.[4] ?? 0,
          y: t?.[5] ?? 0,
          w: (i as unknown as { width?: number }).width ?? 0,
        };
      })
      .filter((i) => i.str.length > 0);

    const text = layoutText(items).trim();
    pages.push({
      page: n,
      text,
      via: text.length >= MIN_CHARS_PER_PAGE ? "text_layer" : "none",
    });
  }

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
