/**
 * Check the posting fetcher against a real URL, without spending a model call.
 *
 *   npm run try-posting -- <url>
 */
import { fetchPosting } from "../src/lib/ingest/posting";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: npm run try-posting -- <url>");
    process.exit(1);
  }

  const out = await fetchPosting(url);
  if (!out.ok) {
    console.log(`✗ ${out.reason}`);
    console.log(`  ${out.message}`);
    // Not a script failure: "we could not confirm this" is a real, expected
    // outcome that the UI handles by falling back to paste.
    process.exit(0);
  }

  const s = out.snapshot;
  console.log(`✓ ${s.title}`);
  console.log(`  locations : ${s.locations.join(" · ") || "(none listed)"}`);
  console.log(`  fidelity  : ${s.fidelity}`);
  console.log(`  captured  : ${s.capturedAt}`);
  console.log(`  length    : ${s.text.length} chars`);
  console.log(`\n--- first 400 chars ---\n${s.text.slice(0, 400)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
