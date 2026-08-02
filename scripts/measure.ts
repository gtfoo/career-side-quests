/**
 * What does ONE read actually cost?
 *
 *   npm run measure -- --posting <url|file> --cv <file> [--github <handle>]
 *
 * Runs a single realistic read — the shape a real user produces — and reports
 * tokens and dollars per stage. One run only: this answers "what does a user
 * cost", not "is the rubric stable" (that is npm run spike).
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  fetchPosting,
  snapshotFromPaste,
  type PostingSnapshot,
} from "../src/lib/ingest/posting";
import { readGithub } from "../src/lib/ingest/github";
import { extractDocument, type SourceDoc } from "../src/lib/ingest/resume";
import { runRead } from "../src/lib/pipeline/assess";
import { ledger } from "../src/lib/usage";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function loadPosting(input: string): Promise<PostingSnapshot> {
  if (/^https?:\/\//.test(input)) {
    const out = await fetchPosting(input);
    if (out.ok) return out.snapshot;
    throw new Error(`Could not fetch posting: ${out.message}`);
  }
  return snapshotFromPaste(await readFile(input, "utf8"), basename(input));
}

async function main() {
  const postingArg = arg("posting");
  const cvArg = arg("cv");
  if (!postingArg || !cvArg) {
    console.error(
      "usage: npm run measure -- --posting <url|file> --cv <file> [--github <handle>]",
    );
    process.exit(1);
  }

  const snapshot = await loadPosting(postingArg);
  const docs: SourceDoc[] = [
    await extractDocument(new Uint8Array(await readFile(cvArg)), basename(cvArg)),
  ];

  const gh = arg("github");
  if (gh) {
    const out = await readGithub(gh);
    if (out.ok) docs.push(out.doc);
    else console.warn(`github: ${out.message}`);
  }

  const inputChars = docs.reduce((n, d) => n + d.text.length, 0);
  console.log("── input");
  console.log(`  posting   ${snapshot.text.length.toLocaleString()} chars`);
  console.log(
    `  documents ${docs.length} (${inputChars.toLocaleString()} chars total)`,
  );

  const started = Date.now();
  const result = await runRead({ snapshot, docs });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n── result`);
  console.log(
    `  ${result.assessment.verdict} · ${result.assessment.carriesOver}% carries over · ${result.target.requirements.length} requirements · ${seconds}s`,
  );
  console.log(`  flags: ${result.flags.length}`);

  console.log("\n" + ledger.report("cost of ONE read"));

  const t = ledger.totals();
  console.log("\n── extrapolation");
  for (const n of [100, 1000, 10000]) {
    console.log(
      `  ${String(n).padStart(6)} reads   $${(t.cost * n).toFixed(2)}`,
    );
  }
  console.log(
    `\n  Assumes no prompt caching. The per-requirement calls share a long\n` +
      `  identical prefix, so a provider cache would cut input cost sharply —\n` +
      `  measure again before trusting any figure above.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
