/**
 * The name a saved read lands in the downloads folder with.
 *
 * There is no server-side PDF renderer here, so the browser's own print-to-PDF
 * is what produces the file — and browsers derive its name from
 * `document.title`. That makes this the only lever available. Worth pulling:
 * the untouched title is the product name, so every read anyone saves collides
 * with the last one, and the whole point of the file is to keep several.
 */
export function readFilename(
  productName: string,
  title?: string | null,
  company?: string | null,
): string {
  // Each part is sanitised BEFORE being joined, so a part that survives as
  // nothing but separators can be dropped rather than left dangling after an
  // em-dash. Sanitising the joined string instead turns a title of "///" into
  // "Career Side Quests — -".
  const clean = (s: string | null | undefined): string =>
    (s ?? "")
      // Control characters first — a scraped job title can carry a stray
      // newline, and turning it into a space before the whitespace pass keeps
      // words apart rather than welding them together. Matched by Unicode
      // category so no literal control character appears in this source file.
      .replace(/\p{Cc}+/gu, " ")
      // Illegal on Windows, or path-forming on POSIX. Browsers do substitute
      // these themselves, but not identically — Chrome writes "_", Safari drops
      // them — and a filename that depends on the browser is a support question
      // waiting to happen.
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();

  // "Has something to say" means at least one letter or digit. Anything less is
  // punctuation noise from a bad scrape and reads as damage in a filename.
  const meaningful = (s: string) => /\p{L}|\p{N}/u.test(s);

  const parts = [clean(title), clean(company)].filter(meaningful);
  const product = clean(productName);
  const raw = [product, parts.join(" at ")].filter(Boolean).join(" — ");

  const cleaned = raw
    // A leading dot hides the file on POSIX; Windows silently strips trailing
    // dots and spaces, which would desync the saved name from the one the
    // print dialog previewed.
    .replace(/^\.+/, "")
    // Long titles get truncated by the OS at a byte limit, which can cut a
    // multi-byte character in half. Cutting well short of any limit, then
    // tidying the edge, avoids the question entirely.
    .slice(0, 120)
    .replace(/[.\s]+$/, "")
    .trim();

  // Everything can still wash out — a punctuation-only product name in a fork,
  // say. Browsers fall back to "download", which is worse than any label here.
  return meaningful(cleaned) ? cleaned : productName;
}
