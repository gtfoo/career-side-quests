/**
 * Regression check for the quote grounder, using real quotes that a model
 * produced and real CV text. No model call.
 *
 *   npm run check-grounding -- --cv <file>
 *
 * SHOULD PASS covers transcription drift a model reliably introduces — swapped
 * dash glyphs, collapsed line breaks, smart quotes. SHOULD FAIL covers the
 * things the grounder exists to catch. Both directions matter: a grounder that
 * is too strict rejects true claims and penalises the candidate, which is the
 * failure mode that actually shipped.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractDocument } from "../src/lib/ingest/resume";
import { isGrounded, normalise } from "../src/lib/pipeline/validate";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const SHOULD_PASS = [
  // Model swapped the source's "●" bullet for an en dash.
  "Tech – APIs, develop functional demos on Python/Node.js, SQL, Data Analytics",
  // Model kept the bullet as-is.
  "● Product Owner: Partnered with Stripe as platform user to launch cards and PayNow acceptance for SMB merchants",
  // Model joined a line break into a single space.
  "Pre-sales & Implementation: Key contributor to the win and delivery of all 2020 APAC targets",
  // Two-column pairing, the bug that started this.
  "Mandarin Chinese  Native / Bilingual",
  // Curly apostrophe in the source, straight one in the quote.
  "Flywire processes high-value int'l payments for schools",
];

const SHOULD_FAIL = [
  // Plausible, fluent, and not in the CV.
  "Led a team of twelve engineers across three continents",
  // Real line with an invented metric spliced in.
  "Defended APAC top account Alipay from churn, growing revenue 45%",
  // Real words, reordered into a claim that was never made.
  "Grew the Data Bundles product from USD20k to USD250m gross profit",
];

async function main() {
  const bytes = new Uint8Array(await readFile(arg("cv")!));
  const doc = await extractDocument(bytes, basename(arg("cv")!));

  let failures = 0;

  const src = normalise(doc.text);

  console.log("SHOULD PASS — transcription drift, not hallucination");
  for (const q of SHOULD_PASS) {
    const ok = isGrounded(q, doc.text);
    if (!ok) failures++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${q.slice(0, 72)}`);
    if (!ok) {
      // Show where the two diverge, rather than guessing at the cause: walk
      // forward until the prefix stops matching.
      const nq = normalise(q);
      let keep = nq.length;
      while (keep > 8 && !src.includes(nq.slice(0, keep))) keep--;
      console.log(`        matched : "${nq.slice(0, keep)}"`);
      console.log(`        diverged: "${nq.slice(keep, keep + 60)}"`);
      const at = src.indexOf(nq.slice(0, keep));
      if (at >= 0) {
        console.log(`        source  : "${src.slice(at, at + keep + 60)}"`);
      }
    }
  }

  console.log("\nSHOULD FAIL — fabricated or altered");
  for (const q of SHOULD_FAIL) {
    const ok = isGrounded(q, doc.text);
    if (ok) failures++;
    console.log(`  ${ok ? "FAIL" : "ok  "}  ${q.slice(0, 72)}`);
  }

  console.log(
    failures === 0
      ? "\n✓ grounder behaves in both directions"
      : `\n✗ ${failures} case(s) wrong`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
