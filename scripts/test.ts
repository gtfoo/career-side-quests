/**
 * The offline suite. No API key, no network, no cost.
 *
 *   npm test
 *
 * Everything here is logic that decides what a user is told but does not need a
 * model to run: scoring arithmetic, verdicts, gap routing, quote grounding,
 * fabricated-metric detection, provider fallback selection, PDF layout.
 *
 * This deliberately does NOT test model judgement — whether a level is the
 * right level is a question only a real run can answer, and that is what
 * `npm run spike` is for. Keeping the two separate matters: a green suite here
 * means the machinery is sound, not that the assessment is good.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { extractDocument } from "../src/lib/ingest/resume";
import { parseGithubHandle } from "../src/lib/ingest/github";
import { snapshotFromPaste } from "../src/lib/ingest/posting";
import {
  aggregate,
  decisiveRequirements,
  distanceFor,
  scoreCarryOver,
  verdictFor,
} from "../src/lib/pipeline/aggregate";
import {
  hasFabricatedMetric,
  isGrounded,
  normalise,
} from "../src/lib/pipeline/validate";
import type { JobTarget, RequirementMatch } from "../src/lib/schema";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`  ${name}\n    expected ${e}\n    actual   ${a}`);
  }
}

function ok(name: string, cond: boolean) {
  check(name, cond, true);
}

function section(title: string) {
  console.log(`\n── ${title}`);
}

// ---------------------------------------------------------------- fixtures

function req(
  id: string,
  over: Partial<JobTarget["requirements"][number]> = {},
): JobTarget["requirements"][number] {
  return {
    id,
    text: `requirement ${id}`,
    quote: `quote ${id}`,
    kind: "hard_skill",
    mustHave: false,
    weight: 3,
    ...over,
  };
}

function target(reqs: JobTarget["requirements"]): JobTarget {
  return {
    title: "Test Role",
    company: null,
    team: null,
    locations: [],
    remote: null,
    requirements: reqs,
  };
}

function match(id: string, level: 0 | 1 | 2 | 3): RequirementMatch {
  return {
    requirementId: id,
    level,
    supporting: [],
    counter: [],
    reasoning: "",
    confidence: "medium",
  };
}

// ------------------------------------------------------------------ scoring

section("scoring is arithmetic, not opinion");

check(
  "all met = 100",
  scoreCarryOver(target([req("R1"), req("R2")]), [match("R1", 3), match("R2", 3)]),
  100,
);
check(
  "none met = 0",
  scoreCarryOver(target([req("R1"), req("R2")]), [match("R1", 0), match("R2", 0)]),
  0,
);
check(
  "half met = 50",
  scoreCarryOver(target([req("R1"), req("R2")]), [match("R1", 3), match("R2", 0)]),
  50,
);
check(
  "a missing match scores as zero, never as absent",
  scoreCarryOver(target([req("R1"), req("R2")]), [match("R1", 3)]),
  50,
);
ok(
  "must-haves outweigh nice-to-haves",
  scoreCarryOver(
    target([req("R1", { mustHave: true }), req("R2")]),
    [match("R1", 3), match("R2", 0)],
  ) >
    scoreCarryOver(
      target([req("R1", { mustHave: true }), req("R2")]),
      [match("R1", 0), match("R2", 3)],
    ),
);
check(
  "eligibility is excluded from the capability score",
  scoreCarryOver(
    target([req("R1"), req("R2", { kind: "eligibility" })]),
    [match("R1", 3), match("R2", 0)],
  ),
  100,
);

// ----------------------------------------------------------------- verdicts

section("the verdict protects against a misleading number");

check(
  "high score with everything met is a lock",
  verdictFor(target([req("R1", { mustHave: true })]), [match("R1", 3)], 95),
  "lock",
);
check(
  "a single unmet must-have caps at stretch however high the score",
  verdictFor(
    target([req("R1", { mustHave: true }), req("R2")]),
    [match("R1", 1), match("R2", 3)],
    92,
  ),
  "stretch",
);
check(
  "low score is a long shot",
  verdictFor(target([req("R1")]), [match("R1", 0)], 20),
  "long_shot",
);

// ----------------------------------------------------------------- distance

section("distance is measured, not assumed");

check("same function and industry", distanceFor({ sameFunction: true, sameIndustry: true, domainOverlap: 1 }), "D0");
check("new industry", distanceFor({ sameFunction: true, sameIndustry: false, domainOverlap: 0.5 }), "D1");
check("new function", distanceFor({ sameFunction: false, sameIndustry: true, domainOverlap: 0.5 }), "D2");
check("neither, some overlap", distanceFor({ sameFunction: false, sameIndustry: false, domainOverlap: 0.5 }), "D3");
check("neither, nothing transfers", distanceFor({ sameFunction: false, sameIndustry: false, domainOverlap: 0.1 }), "D4");

// ---------------------------------------------------------------- priorities

section("the decisive gap is the one worth showing first");

check(
  "heaviest unmet requirement ranks first",
  decisiveRequirements(
    target([
      req("R1", { weight: 1 }),
      req("R2", { weight: 5, mustHave: true }),
      req("R3", { weight: 2 }),
    ]),
    [match("R1", 0), match("R2", 0), match("R3", 0)],
  )[0],
  "R2",
);
check(
  "fully met requirements are not gaps",
  decisiveRequirements(target([req("R1"), req("R2")]), [match("R1", 3), match("R2", 1)]),
  ["R2"],
);

// -------------------------------------------------------------- aggregation

section("aggregate ties it together");

const agg = aggregate({
  target: target([req("R1", { mustHave: true }), req("R2")]),
  matches: [match("R1", 3), match("R2", 1)],
  sameFunction: true,
  sameIndustry: false,
  domainOverlap: 0.6,
});
check("distance flows through", agg.distance, "D1");
ok("score is a percentage", agg.carriesOver >= 0 && agg.carriesOver <= 100);
ok("verdict is one of three", ["lock", "stretch", "long_shot"].includes(agg.verdict));

// ---------------------------------------------------------------- grounding

section("grounding: drift passes, fabrication fails");

const SRC = `● Product Owner: Partnered with Stripe as platform user to
launch cards and PayNow acceptance for SMB merchants
Tech ● APIs, develop functional demos on Python/Node.js
Flywire processes high-value int'l payments for schools`;

ok("exact quote", isGrounded("Partnered with Stripe as platform user", SRC));
ok("across a line break", isGrounded("as platform user to launch cards and PayNow", SRC));
ok("bullet swapped for a dash", isGrounded("Tech – APIs, develop functional demos", SRC));
ok("curly apostrophe vs straight", isGrounded("high-value int'l payments", SRC));
ok("fabricated sentence rejected", !isGrounded("Led a team of twelve engineers overseas", SRC));
ok("invented metric rejected", !isGrounded("Partnered with Stripe, growing revenue 45%", SRC));
ok(
  "intra-word hyphen still has to match",
  !isGrounded("Flywire processes high value intl payments for schools", SRC),
);
ok("too short to prove anything", !isGrounded("Stripe", SRC));
check("normalise collapses whitespace", normalise("a   b\n\nc"), "a b c");

// ------------------------------------------------------- fabricated metrics

section("the app cannot invent numbers for a CV");

ok("placeholder is fine", !hasFabricatedMetric("Cut synthesis calls by {{n}}%"));
ok("a bare number is not", hasFabricatedMetric("Cut synthesis calls by 40%"));
ok("a year is not", hasFabricatedMetric("Shipped in 2024"));
ok("prose with no digits is fine", !hasFabricatedMetric("Shipped and maintain a public extension"));

// ------------------------------------------------------------------ github

section("github handles");

check("bare handle", parseGithubHandle("gtfoo"), "gtfoo");
check("profile url", parseGithubHandle("https://github.com/gtfoo"), "gtfoo");
check("repo url takes the owner", parseGithubHandle("github.com/gtfoo/some-repo"), "gtfoo");
check("@ prefix", parseGithubHandle("@gtfoo"), "gtfoo");
check("nonsense rejected", parseGithubHandle("not a handle!"), null);
check("empty rejected", parseGithubHandle("   "), null);

// ----------------------------------------------------------------- postings

section("pasted text is the path that must never break");

const pasted = snapshotFromPaste("Some job description text");
check("fidelity is honest about itself", pasted.fidelity, "pasted");
check("no posting id to match on", pasted.postingId, null);
ok("text preserved", pasted.text.includes("Some job description"));

// --------------------------------------------------------------- pdf layout

async function pdfTests() {
  const path = process.argv[process.argv.indexOf("--cv") + 1];
  if (process.argv.indexOf("--cv") === -1 || !path) {
    console.log("\n── pdf layout (skipped: pass --cv <file> to include)");
    return;
  }
  section("pdf layout keeps two-column pairs together");
  const doc = await extractDocument(new Uint8Array(await readFile(path)), basename(path));
  ok("something was read", doc.text.length > 500);
  ok("coverage reported", doc.coverage > 0);
  ok(
    "sidebar label stays with its value",
    isGrounded("Mandarin Chinese  Native / Bilingual", doc.text),
  );
  ok(
    "sidebar text is not spliced into main-column prose",
    !/platform user to\s+MBA/i.test(doc.text),
  );
}

pdfTests()
  .then(() => {
    console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log("\nfailures:");
      console.log(failures.join("\n"));
    }
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
