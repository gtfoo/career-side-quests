/**
 * Deterministic checks that run AFTER the model and before anything reaches a
 * user. None of these need an LLM, all of them are cheap, and together they are
 * what let the app claim its scores are evidenced rather than imagined.
 *
 * The rule: if a model says a source contains something, that something must
 * literally be in the source. A quote that fails is a hallucination, and the
 * call is regenerated (see withValidation()).
 */

/**
 * Quotes come back with cosmetic drift — smart quotes, collapsed whitespace,
 * a stray bullet glyph, different dashes. Those are not hallucinations, so
 * normalise both sides before comparing. Anything beyond this (dropped words,
 * reordered clauses, invented numbers) SHOULD fail.
 */
export function normalise(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[•▪●·]/g, " ")
    // A STANDALONE dash or bullet is a list marker, and models freely swap one
    // for another when copying ("Tech ● APIs" quoted as "Tech – APIs"). That is
    // transcription drift, not a fabricated claim, so both collapse away.
    // Intra-word hyphens are untouched: "pre-sales" and "cross-border" carry
    // meaning and still have to match.
    .replace(/(^|\s)-+(?=\s|$)/g, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Is `quote` genuinely present in `source`? */
export function isGrounded(quote: string, source: string): boolean {
  const q = normalise(quote);
  // A quote so short it would match by accident proves nothing.
  if (q.length < 8) return false;
  return normalise(source).includes(q);
}

export type ValidationIssue = {
  path: string;
  problem: string;
  detail?: string;
};

/**
 * Resume bullets we generate must never contain a number the candidate has not
 * given us. The model writes `{{n}}%` and the user fills it in. Anything else
 * with digits is an invented metric — the single fastest way for this app to
 * make someone lie on their CV.
 *
 * Digits inside {{...}} are fine. Bare years and counts are not.
 */
export function hasFabricatedMetric(text: string): boolean {
  const withoutPlaceholders = text.replace(/\{\{[^}]*\}\}/g, "");
  return /\d/.test(withoutPlaceholders);
}

/** Every quoted span in a match must exist in the material it cites. */
export function checkQuotes(
  claims: Array<{ path: string; quote: string | null | undefined }>,
  source: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const c of claims) {
    if (!c.quote) continue;
    if (!isGrounded(c.quote, source)) {
      issues.push({
        path: c.path,
        problem: "quote not found in source",
        detail: c.quote.slice(0, 120),
      });
    }
  }
  return issues;
}

/** Ids a model refers to must be ids we actually gave it. */
export function checkIds(
  refs: Array<{ path: string; id: string }>,
  known: Set<string>,
): ValidationIssue[] {
  return refs
    .filter((r) => !known.has(r.id))
    .map((r) => ({ path: r.path, problem: "unknown id", detail: r.id }));
}

/**
 * Run a generation, validate it, and retry on failure with the problems fed
 * back in. Two attempts, then give up — a model that cannot ground its quotes
 * twice in a row will not manage it on the third try, and silently returning
 * unvalidated output would defeat the point.
 */
export async function withValidation<T>(args: {
  /** `feedback` is null on the first try; non-null means this is a retry. */
  attempt: (feedback: string | null) => Promise<T>;
  validate: (value: T) => ValidationIssue[];
  label: string;
  maxAttempts?: number;
}): Promise<{ value: T; attempts: number; issues: ValidationIssue[] }> {
  const maxAttempts = args.maxAttempts ?? 2;
  let feedback: string | null = null;
  let last: { value: T; issues: ValidationIssue[] } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const value = await args.attempt(feedback);
    const issues = args.validate(value);
    if (issues.length === 0) return { value, attempts: attempt, issues: [] };

    last = { value, issues };
    feedback = [
      "Your previous answer failed validation. Fix these and answer again.",
      ...issues.map(
        (i) => `- ${i.path}: ${i.problem}${i.detail ? ` — "${i.detail}"` : ""}`,
      ),
      "",
      "Every quote must be copied EXACTLY from the source text, character for character.",
      "If no exact quote supports a claim, lower the level or drop the claim.",
    ].join("\n");

    console.warn(
      `[${args.label}] attempt ${attempt} failed validation (${issues.length} issue(s)); retrying.`,
    );
  }

  console.error(
    `[${args.label}] still failing after ${maxAttempts} attempts; returning flagged result.`,
  );
  return { value: last!.value, attempts: maxAttempts, issues: last!.issues };
}
