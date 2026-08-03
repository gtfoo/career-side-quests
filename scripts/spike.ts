/**
 * Phase 0 — does the rubric hold still?
 *
 * Runs the full pipeline N times on the same input and reports how much the
 * score moves. This is the gate for everything downstream: if the same CV
 * against the same posting swings ±15 points between runs, the rubric is
 * underspecified and no amount of UI will make the output trustworthy.
 *
 *   npm run spike -- --posting <url|file> --cv <file> [--runs 3]
 *
 * Prints a per-requirement level spread, so when it IS unstable you can see
 * which requirement is doing it rather than guessing.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  fetchPosting,
  snapshotFromPaste,
  type PostingSnapshot,
} from "../src/lib/ingest/posting";
import {
  coverageNotice,
  extractDocument,
  type SourceDoc,
} from "../src/lib/ingest/resume";
import { aggregate } from "../src/lib/pipeline/aggregate";
import { extractCandidate, extractJobTarget } from "../src/lib/pipeline/extract";
import { matchAll } from "../src/lib/pipeline/match";
import type { RequirementMatch } from "../src/lib/schema";
import { requireExplicitApproval } from "../src/lib/spend";

// Must run before anything can reach a model. Without --allow-spend this
// revokes any standing permission inherited from .env.local. The spike is the
// most expensive script here — it runs a full read N times over.
requireExplicitApproval();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function loadPosting(input: string): Promise<PostingSnapshot> {
  if (/^https?:\/\//.test(input)) {
    const out = await fetchPosting(input);
    if (out.ok) return out.snapshot;
    throw new Error(
      `Could not fetch posting (${out.reason}): ${out.message}\n` +
        `Save the description to a .txt file and pass that instead.`,
    );
  }
  return snapshotFromPaste(await readFile(input, "utf8"), basename(input));
}

async function loadCv(path: string): Promise<SourceDoc> {
  const bytes = new Uint8Array(await readFile(path));
  return extractDocument(bytes, basename(path));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function main() {
  const postingArg = arg("posting");
  const cvArg = arg("cv");
  const runs = Number(arg("runs") ?? 3);

  if (!postingArg || !cvArg) {
    console.error(
      "usage: npm run spike -- --posting <url|file> --cv <file> [--runs 3]",
    );
    process.exit(1);
  }

  console.log("→ loading inputs");
  const snapshot = await loadPosting(postingArg);
  const cv = await loadCv(cvArg);

  const notice = coverageNotice(cv);
  if (notice) console.warn(`⚠  ${notice}`);
  console.log(
    `   posting: ${snapshot.title ?? "(untitled)"} — ${snapshot.text.length} chars, fidelity=${snapshot.fidelity}`,
  );
  console.log(
    `   cv: ${cv.filename} — ${cv.pages.length} page(s), coverage ${(cv.coverage * 100).toFixed(0)}%`,
  );

  // Extraction runs ONCE. We are measuring the stability of judgement, not of
  // parsing — varying both at the same time would tell us nothing about either.
  console.log("\n→ extracting job requirements");
  const { target, issues: jdIssues } = await extractJobTarget(snapshot);
  console.log(`   ${target.requirements.length} requirements`);
  if (jdIssues.length) console.warn(`   ⚠ ${jdIssues.length} ungrounded quote(s)`);

  console.log("→ extracting candidate evidence");
  const { profile, issues: evIssues } = await extractCandidate([cv]);
  console.log(`   ${profile.atoms.length} evidence atoms`);
  if (evIssues.length) console.warn(`   ⚠ ${evIssues.length} ungrounded quote(s)`);

  const scores: number[] = [];
  const levels = new Map<string, number[]>();

  for (let run = 1; run <= runs; run++) {
    process.stdout.write(`\n→ run ${run}/${runs} — scoring`);
    const results = await matchAll({
      target,
      profile,
      candidateSource: cv.text,
    });
    const matches: RequirementMatch[] = results.map((r) => r.match);

    for (const m of matches) {
      levels.set(m.requirementId, [
        ...(levels.get(m.requirementId) ?? []),
        m.level,
      ]);
    }

    const scored = aggregate({
      target,
      matches,
      // Hardcoded for the spike; the real pipeline derives these.
      sameFunction: true,
      sameIndustry: false,
      domainOverlap: 0.5,
    });
    scores.push(scored.carriesOver);

    const flagged = results.filter((r) => r.issues.length).length;
    console.log(
      ` → ${scored.carriesOver}% (${scored.verdict})${flagged ? ` ⚠ ${flagged} flagged` : ""}`,
    );

    // The quotes that could not be grounded, verbatim. Without seeing the text
    // itself there is no way to tell a hallucination from a validator that is
    // too strict — and those need opposite fixes.
    if (process.env.SHOW_ISSUES) {
      for (const r of results) {
        for (const i of r.issues) {
          console.log(
            `      [${r.match.requirementId}] ${i.path}: ${i.problem}\n        "${i.detail ?? ""}"`,
          );
        }
      }
    }
  }

  console.log("\n────────── stability ──────────");
  const spread = Math.max(...scores) - Math.min(...scores);
  console.log(`scores      ${scores.join(", ")}`);
  console.log(`median      ${median(scores)}%`);
  console.log(`spread      ${spread} points`);
  console.log(`reqs        ${target.requirements.length} extracted`);
  console.log(
    `unstable    ${[...levels.values()].filter((ls) => new Set(ls).size > 1).length} of ${levels.size} requirements moved`,
  );

  const unstable = [...levels.entries()]
    .map(([id, ls]) => ({ id, ls, range: Math.max(...ls) - Math.min(...ls) }))
    .filter((r) => r.range > 0)
    .sort((a, b) => b.range - a.range);

  if (unstable.length) {
    console.log("\nrequirements that moved between runs:");
    for (const u of unstable) {
      const req = target.requirements.find((r) => r.id === u.id);
      console.log(
        `  ${u.id}  ${u.ls.join(" ")}  (±${u.range})  ${req?.text.slice(0, 60) ?? ""}`,
      );
    }
  } else {
    console.log("\nevery requirement scored identically across runs.");
  }

  console.log(
    spread <= 10
      ? "\n✓ stable enough to build on."
      : `\n✗ ${spread}-point swing. Tighten the level definitions for the requirements above before building further.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
