/**
 * What this app reports about itself, to `/var/lib/usage/`.
 *
 * Two files, two contracts, both owned by gtfoo and tracked there rather than
 * in the letters that announced them — `gtfoo/docs/usage-tracking.md` and
 * `gtfoo/docs/user-counts.md`. Read those, not this comment, if the shapes
 * disagree: carpark once had to recover the usage schema from a mailbox's git
 * history, which is the failure mode the tracked contracts exist to prevent.
 *
 * Everything here is fire-and-forget. Instrumentation that can fail a user's
 * request is worse than no instrumentation, so every write swallows its errors
 * and none is ever awaited on a request path. On a dev machine
 * `/var/lib/usage` does not exist and every call here is a silent no-op, which
 * is the intended behaviour rather than an oversight.
 */

import { rename, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const APP = "career-side-quests";

/** Overridable so tests can point at a scratch directory. */
function dir(): string {
  return process.env.USAGE_DIR ?? "/var/lib/usage";
}

// --------------------------------------------------------------- billable calls

export type UsageLine = {
  provider: string;
  /** The RESOLVED model, never the alias — an alias moves under you. */
  model?: string | null;
  op?: string | null;
  requests?: number;
  in_tokens?: number | null;
  out_tokens?: number | null;
  /**
   * Cache tokens, counted INSIDE in_tokens rather than beside it — rule 9 of
   * the usage contract. `null` where the provider does not report them, which
   * is the same unmeasured-vs-zero distinction as `usd`: 0 would claim a call
   * read nothing from cache, and unreported is not that claim.
   *
   * This app cares more than most. Its fan-out is built around a shared prompt
   * prefix, so most input on a read is a cache READ at roughly a tenth of the
   * price of a fresh token. A ledger that cannot tell them apart makes a
   * deliberately cheap design look like the most expensive app on the box.
   */
  in_cache_read?: number | null;
  in_cache_write?: number | null;
  /** Non-token billing only (characters, credits). Null for LLM calls. */
  units?: number | null;
  status: "ok" | "rate_limited" | "error";
};

/**
 * One line per billable call.
 *
 * `usd` is deliberately always null. This app has a price table
 * (`src/lib/usage.ts`) and could compute a figure, but the contract's own rule
 * is that null means UNMEASURED and that *knowing a rate is not the same as
 * having measured a bill* — the reason fluent emits ElevenLabs as null despite
 * its list rate being public. A number derived from a hardcoded table would sit
 * on the dashboard looking like a measurement, next to a real balance poll that
 * disagrees with it. The local table stays where it is: a labelled estimate in
 * a spike report, not a fact on someone else's page.
 */
export function recordUsage(call: UsageLine): void {
  const line =
    JSON.stringify({
      // UTC, because the dashboard compares this lexicographically against a
      // cutoff string rather than parsing it. An offset stamp is a valid
      // instant that sorts as though it were UTC, so local-offset lines drift
      // in and out of the window silently.
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      app: APP,
      requests: 1,
      units: null,
      usd: null,
      ...call,
    }) + "\n";

  // Over 4096 bytes an O_APPEND write stops being atomic and can interleave
  // with another app's line — and the corruption reads as malformed JSON from
  // whichever app is blamed second. Nothing here should come close; truncating
  // the free-text field is better than poisoning a shared file.
  const safe =
    line.length <= 4096
      ? line
      : JSON.stringify({
          ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          app: APP,
          provider: call.provider,
          status: call.status,
          requests: call.requests ?? 1,
          units: null,
          usd: null,
        }) + "\n";

  void appendFile(join(dir(), `${APP}.jsonl`), safe).catch(() => {});
}

// -------------------------------------------------------------- user counts

export type UserCounts = {
  total: number;
  magic_link: number | null;
  passkey: number | null;
  active_30d: number | null;
};

/**
 * Counts only — never identifiers, and never a per-person timestamp. The panel
 * needs a number, and a file one app writes and another reads is the wrong
 * place to widen what is known about anyone.
 *
 * Written atomically: a temp file in the same directory, then rename. The
 * dashboard reads these concurrently and a truncating writer lets it read half
 * a JSON document.
 */
export function writeUserCounts(users: UserCounts): void {
  const body =
    JSON.stringify({
      app: APP,
      generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      users,
    }) + "\n";

  // Same directory as the target, or rename() crosses a filesystem and fails.
  const tmp = join(dir(), `.${APP}.users.json.tmp`);
  void writeFile(tmp, body)
    .then(() => rename(tmp, join(dir(), `${APP}.users.json`)))
    .catch(() => {});
}
