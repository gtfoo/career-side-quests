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
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { extractDocument } from "../src/lib/ingest/resume";
import { parseGithubHandle } from "../src/lib/ingest/github";
import {
  boardFor,
  parseBoardUrl,
  snapshotFromPaste,
} from "../src/lib/ingest/posting";
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
import { readFilename } from "../src/lib/filename";
import { resolveChain } from "../src/lib/llm";
import { UsageLedger } from "../src/lib/usage";
import * as ratelimit from "../src/lib/ratelimit";
import { requireExplicitApproval, spendAllowed } from "../src/lib/spend";
import * as db from "../src/lib/store/db";
import * as passkeys from "../src/lib/store/passkeys";
import { SqliteAdapter } from "../src/lib/store/adapter";
import * as localStore from "../src/lib/store/local";
import { deriveGaps } from "../src/lib/pipeline/assess";
import { checkBrief } from "../src/lib/pipeline/quest";
import type {
  JobTarget,
  ProjectBrief,
  RequirementMatch,
} from "../src/lib/schema";

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

section("attributes are never handed a weekend project");

{
  // A real run proposed recording bilingual demo videos to prove a language the
  // candidate is native in. Scoring was the root cause, but routing is the
  // second line of defence: no level, however wrong, should produce a build for
  // something a build cannot deliver.
  const t = target([
    req("R1", { kind: "language", text: "Mandarin and English" }),
    req("R2", { kind: "credential", text: "PMP certification" }),
    req("R3", { kind: "seniority", text: "8+ years" }),
    req("R4", { kind: "hard_skill", text: "Python" }),
  ]);
  const gaps = deriveGaps(t, [
    match("R1", 0),
    match("R2", 0),
    match("R3", 0),
    match("R4", 0),
  ]);
  const kindOf = (id: string) => gaps.find((g) => g.requirementId === id)?.kind;

  check("a language gap cannot be shortcut", kindOf("R1"), "cannot_shortcut");
  check("nor a credential", kindOf("R2"), "cannot_shortcut");
  check("nor years of experience", kindOf("R3"), "cannot_shortcut");
  check("but a hard skill can be built", kindOf("R4"), "project");
  ok(
    "and no effort estimate is offered for the unfixable",
    gaps
      .filter((g) => g.kind === "cannot_shortcut")
      .every((g) => g.effortHours === null),
  );
}

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

// A company-hosted board puts the org in the DOMAIN, not the path, and users
// paste whichever form the address bar gave them. All of these are the same
// posting, and refusing any of them means refusing the feature.
{
  const cases: [string, string][] = [
    [
      "ashby's own host",
      "https://jobs.ashbyhq.com/elevenlabs/85b7489f-5b0c-4f21-9c1c-7b76ed904c44",
    ],
    [
      "company-hosted, with ashby_jid",
      "https://elevenlabs.io/careers/85b7489f-5b0c-4f21-9c1c-7b76ed904c44/enterprise-solutions-engineer-singapore?ashby_jid=85b7489f-5b0c-4f21-9c1c-7b76ed904c44",
    ],
    [
      "company-hosted, query string stripped",
      "https://elevenlabs.io/careers/85b7489f-5b0c-4f21-9c1c-7b76ed904c44/enterprise-solutions-engineer-singapore",
    ],
    [
      "company-hosted, with www",
      "https://www.elevenlabs.io/careers/85b7489f-5b0c-4f21-9c1c-7b76ed904c44/x",
    ],
  ];
  for (const [label, u] of cases) {
    const p = parseBoardUrl(new URL(u));
    ok(
      `${label} → org+id`,
      p?.org === "elevenlabs" && Boolean(p?.id?.startsWith("85b7489f")),
    );
  }

  // A looser matcher must never steal a URL another adapter identifies exactly.
  ok(
    "greenhouse keeps its own urls",
    boardFor(new URL("https://boards.greenhouse.io/acme/jobs/123")) === "greenhouse",
  );
  ok(
    "lever keeps its own urls",
    boardFor(new URL("https://jobs.lever.co/acme/abc-def")) === "lever",
  );
  ok(
    "a plain url matches nothing",
    boardFor(new URL("https://example.com/about")) === null,
  );
}

const pasted = snapshotFromPaste("Some job description text");
check("fidelity is honest about itself", pasted.fidelity, "pasted");
check("no posting id to match on", pasted.postingId, null);
ok("text preserved", pasted.text.includes("Some job description"));

// -------------------------------------------------------------- spend gate

section("spending is default-deny");

{
  // Restored afterwards so the rest of the suite is unaffected.
  const saved = process.env.LLM_SPEND;

  delete process.env.LLM_SPEND;
  requireExplicitApproval(["node", "script"]);
  ok("no env, no flag = blocked", !spendAllowed());

  process.env.LLM_SPEND = "allow";
  requireExplicitApproval(["node", "script"]);
  ok("standing permission alone does NOT let a script spend", !spendAllowed());

  delete process.env.LLM_SPEND;
  requireExplicitApproval(["node", "script", "--allow-spend"]);
  ok("flag alone is not enough either", !spendAllowed());

  process.env.LLM_SPEND = "allow";
  requireExplicitApproval(["node", "script", "--allow-spend"]);
  ok("both together allow it", spendAllowed());

  process.env.LLM_SPEND = "yes";
  requireExplicitApproval(["node", "script", "--allow-spend"]);
  ok("only the exact value 'allow' counts", !spendAllowed());

  // Leave the process blocked, whatever the suite found.
  delete process.env.LLM_SPEND;
  requireExplicitApproval(["node", "script"]);
  if (saved !== undefined) process.env.LLM_SPEND = saved;
}

// ------------------------------------------------------------ side quests

section("a side quest brief has to survive checking");

{
  const JD = "Proficiency in Python and a deep understanding of software architecture.";
  const CV = "Tech - APIs, develop functional demos on Python/Node.js, SQL";

  const good: ProjectBrief = {
    title: "Put a Python backend behind your extension",
    proves: [
      { requirementId: "R1", jdQuote: "Proficiency in Python", from: 1, to: 3 },
    ],
    youAlreadyHave: [
      { what: "API integration patterns", evidenceQuote: "develop functional demos on Python/Node.js" },
    ],
    theStretch: ["Python at service shape", "Quota and caching"],
    timeBudget: { totalHours: 10, sessions: 3 },
    milestones: [
      { id: "m1", title: "Proxy", hours: 3, acceptance: ["no key in the bundle"], beforeCutLine: true },
      { id: "m2", title: "Quota", hours: 3, acceptance: ["over quota returns an error"], beforeCutLine: true },
      { id: "m3", title: "Tests", hours: 4, acceptance: ["429 degrades to a message"], beforeCutLine: false },
    ],
    proofArtifacts: ["repo", "readme"],
    resumeBullets: ["Cut synthesis calls by {{n}}% with a caching proxy"],
    talkTrack: { pitch: "I hit the key-custody problem...", likelyFollowUps: ["How did you handle quota?"] },
    honestLimits: "Does not show production scale.",
  };

  const sources = { jdText: JD, candidateText: CV };
  check("a well-formed brief passes", checkBrief(good, sources), []);

  const problem = (b: ProjectBrief) =>
    checkBrief(b, sources).map((i) => i.path)[0];

  // Each of these is a way the output looks right and is wrong.
  check(
    "an unquotable JD claim is caught",
    problem({ ...good, proves: [{ ...good.proves[0]!, jdQuote: "Deep Kubernetes expertise" }] }),
    "proves R1",
  );
  check(
    "a fabricated 'you already have' is caught",
    problem({
      ...good,
      youAlreadyHave: [{ what: "Ran a platform team", evidenceQuote: "led a team of twelve engineers" }],
    }),
    "youAlreadyHave[0]",
  );
  check(
    "milestones that don't sum to the budget are caught",
    problem({ ...good, timeBudget: { totalHours: 40, sessions: 3 } }),
    "timeBudget",
  );
  check(
    "a cut line that isn't actually lighter is caught",
    problem({
      ...good,
      milestones: good.milestones.map((m) => ({ ...m, beforeCutLine: true })),
    }),
    "cutLine",
  );
  check(
    "no shippable set at all is caught",
    problem({
      ...good,
      milestones: good.milestones.map((m) => ({ ...m, beforeCutLine: false })),
    }),
    "cutLine",
  );
  check(
    "an invented metric on a CV line is caught",
    problem({ ...good, resumeBullets: ["Cut synthesis calls by 40% with a caching proxy"] }),
    "resumeBullets[0]",
  );
  check(
    "a level that doesn't actually move is caught",
    problem({ ...good, proves: [{ ...good.proves[0]!, from: 3, to: 3 }] }),
    "proves R1",
  );

  // Placeholders must survive: the number is the candidate's to fill in.
  ok(
    "a {{placeholder}} metric is allowed",
    checkBrief(
      { ...good, resumeBullets: ["Served {{n}} requests across {{m}} users"] },
      sources,
    ).length === 0,
  );
}

// ------------------------------------------------------------ persistence

section("saved reads belong to exactly one account");

{
  const tmp = join(tmpdir(), `csq-test-${Date.now()}.db`);
  db._resetForTests(tmp);

  const conn = db.getDb();
  // Guard against the failure this suite already had once: if the path is not
  // honoured, these tests silently mutate the real development database.
  ok("tests use a scratch database, not data/app.db", conn.name === tmp);
  const mkUser = (id: string, email: string) =>
    conn
      .prepare(
        `INSERT INTO users (id, email, name, image, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, email, null, null, new Date().toISOString(), new Date().toISOString());

  mkUser("alice", "alice@example.com");
  mkUser("bob", "bob@example.com");

  // The counts gtfoo.com/admin renders. Exercised against the real schema
  // because the risk here is a silently wrong SQL join, not a wrong shape —
  // report.ts is tested separately and would happily serialise nonsense.
  {
    conn
      .prepare(
        `UPDATE users SET last_seen_at = ? WHERE id = 'bob'`,
      )
      .run(new Date(Date.now() - 90 * 864e5).toISOString());

    const offered = db.userCounts(true);
    check("total counts every account", offered.total, 2);
    check("magic_link counts accounts with no OAuth row", offered.magic_link, 2);
    check("active_30d excludes a user last seen 90 days ago", offered.active_30d, 1);
    // Offered but unused is 0 — a real number, and the thing null must not be
    // collapsed into.
    check("a method offered but unused is 0, not null", offered.passkey, 0);

    // And the distinction the contract exists for: passkeys are behind
    // AUTH_PASSKEYS and off in production, so the honest answer is "not
    // offered" rather than "nobody uses it".
    check("a method not offered is null, not 0", db.userCounts(false).passkey, null);
  }

  const aliceRead = db.saveRead({
    userId: "alice",
    title: "Solutions Engineer",
    verdict: "stretch",
    carriesOver: 72,
    target: { title: "SE" },
    assessment: { verdict: "stretch" },
  });

  check("owner sees their read", db.listReads("alice").length, 1);
  check("other accounts see nothing", db.listReads("bob").length, 0);
  ok("owner can fetch it", Boolean(db.getRead("alice", aliceRead)));

  // The one that matters. A leaked or guessed id must not be enough.
  check(
    "a known read id is useless to another account",
    db.getRead("bob", aliceRead),
    undefined,
  );
  check("and cannot be deleted by them", db.deleteRead("bob", aliceRead), 0);
  ok("so it is still there", Boolean(db.getRead("alice", aliceRead)));

  check("the owner can delete it", db.deleteRead("alice", aliceRead), 1);
  check("and then it is gone", db.listReads("alice").length, 0);

  // Retention: an expired read is invisible even to its owner.
  const old = db.saveRead({
    userId: "alice",
    title: "Old",
    verdict: "lock",
    carriesOver: 90,
    target: {},
    assessment: {},
  });
  conn
    .prepare(`UPDATE reads SET expires_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), old);
  check("expired reads are not listed", db.listReads("alice").length, 0);
  check("nor fetchable", db.getRead("alice", old), undefined);
  check("and the sweep removes them", db.purgeExpired(), 1);

  // Deleting an account takes its data with it.
  db.saveRead({
    userId: "bob",
    title: "Bob's",
    verdict: "lock",
    carriesOver: 80,
    target: {},
    assessment: {},
  });
  db.deleteAccount("bob");
  check("account deletion cascades to reads", db.listReads("bob").length, 0);

  conn.close();
  rmSync(tmp, { force: true });
  rmSync(`${tmp}-wal`, { force: true });
  rmSync(`${tmp}-shm`, { force: true });
}

section("the adapter satisfies the WebAuthn provider");

{
  // This exists because the failure it catches is completely invisible until
  // the day someone enables the feature. `getAccount` was missing: with
  // AUTH_PASSKEYS off the app is perfectly healthy, and the moment it is on,
  // Auth.js validates the adapter up front and EVERY auth route returns 500
  // MissingAdapterMethods — sign-in link included, so turning on passkeys
  // takes out the sign-in that was already working. Nothing warns at build
  // time and the type checker does not require these, because the base Adapter
  // type marks them optional.
  const adapter = SqliteAdapter() as Record<string, unknown>;
  for (const m of [
    "getAccount",
    "getAuthenticator",
    "createAuthenticator",
    "listAuthenticatorsByUserId",
    "updateAuthenticatorCounter",
  ]) {
    ok(`adapter implements ${m}`, typeof adapter[m] === "function");
  }
  // The base methods the email flow needs, so a passkey change cannot quietly
  // remove one.
  for (const m of [
    "createUser",
    "getUserByEmail",
    "createVerificationToken",
    "useVerificationToken",
  ]) {
    ok(`adapter still implements ${m}`, typeof adapter[m] === "function");
  }
}

section("the timing report distinguishes overlap from speed");

{
  // This is the instrument the "is it actually parallel?" question gets
  // answered with, so it is worth pinning. Summed model time is NOT what a user
  // waits: calls overlap. The ratio between them is the whole signal.
  const l = new UsageLedger();
  const call = (stage: string, ms: number, retry = false) => ({
    stage,
    modelSpec: "openai:gpt-5",
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    isRetry: retry,
    ms,
  });

  for (const c of [call("match", 4000), call("match", 4000), call("match", 4000)]) {
    l.record(c);
  }
  const t = l.totals();
  check("model time sums every call", t.modelMs, 12000);
  check("slowest call is tracked for the critical path", t.slowestMs, 4000);

  // Three 4s calls finishing in 4.2s of wall clock is ~3x overlap: parallel.
  const parallel = l.report("x", 4200);
  ok("near-perfect overlap reports ~2.9x", parallel.includes("2.9x overlap"));
  ok("and is not flagged as serial", !parallel.includes("effectively serial"));

  // The same three calls taking 12s ran one after another, and the report has
  // to say so — a "parallel" pipeline that quietly serialised is exactly the
  // regression this exists to catch.
  const serial = l.report("x", 12000);
  ok("no overlap reports 1.0x", serial.includes("1.0x overlap"));
  ok("and is called out as serial", serial.includes("effectively serial"));

  const l2 = new UsageLedger();
  l2.record(call("match", 3000));
  l2.record(call("match", 5000, true));
  check("retry time is attributed as waste", l2.totals().wastedMs, 5000);
  ok("and shown", l2.report("x").includes("wasted time"));
}

section("passkeys are scoped to their owner");

{
  const tmp2 = join(tmpdir(), `csq-pk-${Date.now()}.db`);
  db._resetForTests(tmp2);
  const conn = db.getDb();
  const now = new Date().toISOString();
  for (const [id, email] of [
    ["alice", "a@example.com"],
    ["mallory", "m@example.com"],
  ] as const) {
    conn
      .prepare(
        `INSERT INTO users (id, email, name, image, created_at, last_seen_at)
         VALUES (?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, email, now, now);
  }
  conn
    .prepare(
      `INSERT INTO authenticators
         (credential_id, user_id, provider_account_id, credential_public_key,
          counter, credential_device_type, credential_backed_up, transports, created_at)
       VALUES ('cred-1', 'alice', 'acct-1', 'pub', 0, 'multiDevice', 1, NULL, ?)`,
    )
    .run(now);

  const listed = passkeys.listPasskeys("alice");
  check("the owner sees their passkey", listed.length, 1);
  check("with a readable device type", listed[0]?.deviceType, "multiDevice");
  ok(
    "and no credential material reaches the caller",
    !Object.keys(listed[0] ?? {}).some((k) =>
      /public|counter|transport/i.test(k),
    ),
  );

  check("nobody else sees it", passkeys.listPasskeys("mallory").length, 0);
  // A lost laptop's passkey must be revocable, and only by its owner.
  ok(
    "a known credential id is useless to another account",
    !passkeys.removePasskey("mallory", "cred-1"),
  );
  ok("it survives that attempt", passkeys.hasPasskeys("alice"));
  ok("the owner can revoke it", passkeys.removePasskey("alice", "cred-1"));
  ok("and then it is gone", !passkeys.hasPasskeys("alice"));

  // Deleting an account must take its credentials with it.
  conn
    .prepare(
      `INSERT INTO authenticators
         (credential_id, user_id, provider_account_id, credential_public_key,
          counter, credential_device_type, credential_backed_up, transports, created_at)
       VALUES ('cred-2', 'alice', 'acct-2', 'pub', 0, 'singleDevice', 0, NULL, ?)`,
    )
    .run(now);
  db.deleteAccount("alice");
  ok("account deletion cascades to passkeys", !passkeys.hasPasskeys("alice"));

  // token_version distinguishes "revoked" from "deleted"; collapsing them to 0
  // would let a deleted account's JWT keep working.
  check("a deleted user has no token version", db.tokenVersion("alice"), null);
  check("a live user has one", db.tokenVersion("mallory"), 0);

  conn.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${tmp2}${s}`, { force: true });
}

section("rate limits protect the expensive and the sendable");

{
  ratelimit._clear();
  const req = (ip: string) =>
    new Request("https://x/api/assess", { headers: { "x-forwarded-for": ip } });

  const key = ratelimit.clientKey(req("1.2.3.4"), "assess");
  let last = { ok: true, remaining: 0, retryAfterSeconds: 0 };
  for (let i = 0; i < ratelimit.LIMITS.assess.limit; i++) {
    last = ratelimit.check(key, ratelimit.LIMITS.assess);
  }
  ok("calls up to the limit are allowed", last.ok);
  const over = ratelimit.check(key, ratelimit.LIMITS.assess);
  ok("the next one is refused", !over.ok);
  ok("and says when to retry", over.retryAfterSeconds > 0);

  const other = ratelimit.clientKey(req("5.6.7.8"), "assess");
  ok(
    "a different caller is unaffected",
    ratelimit.check(other, ratelimit.LIMITS.assess).ok,
  );

  ok(
    "scopes are independent",
    ratelimit.check(ratelimit.clientKey(req("1.2.3.4"), "signin"), ratelimit.LIMITS.signin)
      .ok,
  );
  ratelimit._clear();
}

// ------------------------------------------------- personal data routing

section("a CV never reaches a provider that trains on input");

{
  const saved = { ...process.env };
  const reset = () => {
    for (const k of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_PAID_TIER",
      "MODEL_MATCH",
      "MODEL_DEFAULT",
    ])
      delete process.env[k];
  };

  // Google free tier trains on submissions and permits human review, so it may
  // serve the public job posting but never the candidate's own material.
  reset();
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "x";
  process.env.OPENAI_API_KEY = "y";
  ok(
    "posting extraction may use the cheap provider",
    resolveChain("extract_jd")[0]!.startsWith("google:"),
  );
  ok(
    "evidence extraction may not",
    !resolveChain("extract_evidence").some((s) => s.startsWith("google:")),
  );
  ok(
    "matching may not",
    !resolveChain("match").some((s) => s.startsWith("google:")),
  );

  // Running out of paid credit is not a reason to send a CV somewhere unsafe.
  reset();
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "x";
  let threw = false;
  try {
    resolveChain("match");
  } catch {
    threw = true;
  }
  ok("google-only config refuses to score a CV at all", threw);
  ok(
    "but can still read a public posting",
    resolveChain("extract_jd")[0]!.startsWith("google:"),
  );

  // The paid tier does not train on input, so declaring it unlocks everything.
  process.env.GOOGLE_PAID_TIER = "true";
  ok(
    "GOOGLE_PAID_TIER=true permits personal data",
    resolveChain("match")[0]!.startsWith("google:"),
  );

  // A hand-set override must not be able to waive the user's privacy.
  reset();
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "x";
  process.env.ANTHROPIC_API_KEY = "z";
  process.env.MODEL_MATCH = "google:gemini-flash-latest,anthropic:claude-opus-4-8";
  ok(
    "an explicit override cannot route a CV to a training provider",
    !resolveChain("match").some((s) => s.startsWith("google:")),
  );
  ok(
    "and the safe entry survives",
    resolveChain("match").some((s) => s.startsWith("anthropic:")),
  );

  reset();
  Object.assign(process.env, saved);
}

// ---------------------------------------------------- device-local storage

section("local storage: survives a refresh, fails safe");

{
  // Node has no localStorage. Stand one up so the real module is exercised
  // rather than a reimplementation of it.
  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;

  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };

  ok("storage detected when present", localStore.isAvailable());
  check("nothing saved yet", localStore.load(), null);

  localStore.save({ url: "https://example.com/job", notes: "built a thing" });
  const back = localStore.load();
  check("url round-trips", back?.url, "https://example.com/job");
  check("notes round-trip", back?.notes, "built a thing");
  ok("savedAt is stamped", Boolean(back?.savedAt));

  localStore.save({ notes: "edited" });
  const merged = localStore.load();
  check("a patch merges rather than replacing", merged?.url, "https://example.com/job");
  check("and applies the change", merged?.notes, "edited");

  // A shape change must orphan old data, not hydrate a stale object into a
  // component that no longer understands it.
  store.set("csq.v1", JSON.stringify({ version: 99, url: "stale" }));
  check("a foreign version is discarded", localStore.load(), null);
  ok("and the key is removed", !store.has("csq.v1"));

  localStore.save({ url: "https://example.com/again" });
  localStore.clear();
  check("clear really clears", localStore.load(), null);

  // Opening the page must not create an entry, and the save that fires one
  // tick after a clear must not resurrect one.
  localStore.save({ url: "", pasted: "", notes: "", docs: [], links: {} });
  ok("empty state writes no key at all", !store.has("csq.v1"));

  localStore.save({ url: "https://example.com/x" });
  ok("real content does write", store.has("csq.v1"));
  localStore.save({ url: "" });
  ok("emptying the last field removes the key again", !store.has("csq.v1"));

  // Private mode, disabled storage, exceeded quota: none of these may throw.
  g.window = {
    localStorage: {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    },
  };
  ok("blocked storage reports unavailable", !localStore.isAvailable());
  check("load degrades to null", localStore.load(), null);
  localStore.save({ url: "x" }); // must not throw
  localStore.clear(); // must not throw
  ok("save and clear swallow storage failures", true);

  if (!hadWindow) delete g.window;
}

// ------------------------------------------------------------- pdf filename

/**
 * The saved-PDF name is derived from a job title we did not write — it comes
 * out of a scraped posting — so the interesting cases are all hostile input,
 * not the happy path.
 */
function filenameTests() {
  section("pdf filename");

  check(
    "role and company are both in the name",
    readFilename("Career Side Quests", "Solutions Engineer", "ElevenLabs"),
    "Career Side Quests — Solutions Engineer at ElevenLabs",
  );
  check(
    "a missing company does not leave a dangling 'at'",
    readFilename("Career Side Quests", "Solutions Engineer", null),
    "Career Side Quests — Solutions Engineer",
  );
  check(
    "a missing role leaves just the product",
    readFilename("Career Side Quests", "", ""),
    "Career Side Quests",
  );

  // A path separator in a title is the one that actually matters: unescaped it
  // turns the download into a directory traversal on POSIX.
  check(
    "slashes cannot form a path",
    readFilename("P", "Sales / Solutions Engineer", null),
    "P — Sales - Solutions Engineer",
  );
  check(
    "windows-illegal characters are replaced, not dropped",
    readFilename("P", 'Eng: "Growth" <APAC>?*|', null),
    "P — Eng- -Growth- -APAC-",
  );
  ok(
    "a newline in a scraped title does not weld words together",
    readFilename("P", "Solutions\nEngineer", null) === "P — Solutions Engineer",
  );
  ok(
    "ordinary punctuation survives",
    readFilename("P", "Engineer (L5), Data & AI", null) ===
      "P — Engineer (L5), Data & AI",
  );
  ok(
    "a leading dot cannot hide the file",
    !readFilename("P", "", "").startsWith(".") &&
      !readFilename(".hidden", "", "").startsWith("."),
  );
  check(
    "trailing dots and spaces are trimmed (windows strips them silently)",
    readFilename("P", "Engineer...  ", null),
    "P — Engineer",
  );
  ok(
    "an absurd title is capped",
    readFilename("P", "x".repeat(400), null).length <= 120,
  );
  check(
    "a title of pure punctuation falls back to the product name",
    readFilename("Career Side Quests", "///", null),
    "Career Side Quests",
  );
}

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

/**
 * What this app reports to /var/lib/usage.
 *
 * Worth testing despite being three small functions: these files are read by
 * another app's dashboard, so a mistake here shows up as gtfoo's bug, and the
 * two rules most likely to be got wrong — UTC stamps and null-vs-zero — both
 * fail silently and look plausible.
 */
async function reportTests() {
  section("what this app reports about itself");

  const dir = join(tmpdir(), `csq-report-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  process.env.USAGE_DIR = dir;
  const report = await import("../src/lib/report");

  report.recordUsage({
    provider: "openai",
    model: "gpt-5",
    op: "match",
    in_tokens: 1200,
    out_tokens: 300,
    status: "ok",
  });
  report.writeUserCounts({ total: 3, magic_link: 3, passkey: null, active_30d: 1 });
  // Both writers are fire-and-forget, so nothing is awaited in production and
  // the test has to wait for the write it deliberately did not await.
  await new Promise((r) => setTimeout(r, 120));

  const line = JSON.parse(
    readFileSync(join(dir, "career-side-quests.jsonl"), "utf8").trim(),
  );
  const counts = JSON.parse(
    readFileSync(join(dir, "career-side-quests.users.json"), "utf8"),
  );

  // The dashboard compares ts LEXICOGRAPHICALLY against a cutoff string rather
  // than parsing it, so an offset stamp is a valid instant that sorts as though
  // it were UTC and drifts in and out of the window silently.
  ok("usage ts ends in Z, never an offset", /Z$/.test(line.ts));
  ok("usage ts has no fractional seconds", !/\.\d+Z$/.test(line.ts));
  ok("counts generated is UTC too", /Z$/.test(counts.generated));

  check("the app names itself", line.app, "career-side-quests");
  check("requests defaults to 1", line.requests, 1);
  check("units is null for a token-billed call", line.units, null);
  // Not 0. A figure computed from a hardcoded price table would sit on the
  // dashboard looking like a measurement, beside a real balance poll that
  // disagrees with it.
  check("usd is null — unmeasured, not free", line.usd, null);
  ok("usd is present rather than absent", "usd" in line);

  // Cache fields: the same unmeasured-vs-zero rule. A provider that reports
  // nothing has not told us the call read zero from cache.
  report.recordUsage({
    provider: "anthropic",
    model: "claude-opus-4-8",
    op: "match",
    in_tokens: 5000,
    out_tokens: 200,
    in_cache_read: 4200,
    in_cache_write: null,
    status: "ok",
  });
  await new Promise((r) => setTimeout(r, 120));
  const cached = JSON.parse(
    readFileSync(join(dir, "career-side-quests.jsonl"), "utf8").trim().split("\n")[1]!,
  );
  check("cache reads are reported", cached.in_cache_read, 4200);
  check("an unreported cache write stays null", cached.in_cache_write, null);
  ok("and is present rather than omitted", "in_cache_write" in cached);
  // Rule 9: cache tokens sit INSIDE in_tokens, not beside it. Were they
  // additive, the dashboard would double-count every cached call.
  ok(
    "cache reads are a subset of in_tokens, not an addition",
    cached.in_cache_read <= cached.in_tokens,
  );

  // The distinction the whole file exists to preserve: null means the method
  // is not offered, 0 would mean it is offered and unused.
  check("a method not offered is null", counts.users.passkey, null);
  ok("null passkey is present, not omitted", "passkey" in counts.users);
  check("a method that is offered reports a number", counts.users.magic_link, 3);

  // Over 4096 bytes an O_APPEND write can interleave with another app's line,
  // and the corruption reads as malformed JSON from whichever app is blamed
  // second.
  report.recordUsage({
    provider: "openai",
    op: "x".repeat(9000),
    status: "error",
  });
  await new Promise((r) => setTimeout(r, 120));
  const lines = readFileSync(join(dir, "career-side-quests.jsonl"), "utf8")
    .trim()
    .split("\n");
  const last = lines[lines.length - 1]!;
  ok("an oversized line is truncated, not written", last.length <= 4096);
  ok("and it is still valid JSON", Boolean(JSON.parse(last).provider));
  ok("every line parses", lines.every((l) => Boolean(JSON.parse(l))));

  // A missing directory is the normal case on a dev machine.
  process.env.USAGE_DIR = join(dir, "does", "not", "exist");
  report.recordUsage({ provider: "openai", status: "ok" });
  report.writeUserCounts({ total: 0, magic_link: 0, passkey: null, active_30d: 0 });
  await new Promise((r) => setTimeout(r, 120));
  ok("an unwritable target is silent, never thrown", true);

  rmSync(dir, { recursive: true, force: true });
  delete process.env.USAGE_DIR;
}

filenameTests();

reportTests()
  .then(() => pdfTests())
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
