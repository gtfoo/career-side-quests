/**
 * Why did a quote fail grounding? Throwaway diagnostic.
 *
 *   npm run diagnose -- --cv <file>
 *
 * Prints the extracted source around each candidate quote so the mismatch is
 * visible, rather than guessing at what normalise() did or did not absorb.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { extractDocument } from "../src/lib/ingest/resume";
import { isGrounded, normalise } from "../src/lib/pipeline/validate";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const path = arg("cv")!;
  const bytes = new Uint8Array(await readFile(path));
  const doc = await extractDocument(bytes, basename(path));

  console.log("=== raw extracted text ===");
  console.log(doc.text);
  console.log("\n=== normalised ===");
  console.log(normalise(doc.text).slice(0, 2000));

  // Quotes a model would plausibly produce for the language requirement.
  const probes = [
    "Mandarin Chinese  Native / Bilingual",
    "Mandarin Chinese Native / Bilingual",
    "English           Native / Bilingual",
    "English Native / Bilingual",
    "Native / Bilingual",
  ];
  console.log("\n=== grounding probes ===");
  for (const p of probes) {
    console.log(`  ${isGrounded(p, doc.text) ? "OK  " : "FAIL"}  "${p}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
