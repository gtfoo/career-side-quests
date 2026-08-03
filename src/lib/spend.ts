/**
 * The spend gate.
 *
 * Every paid model call in this codebase goes through generate() in llm.ts, and
 * generate() asks here first. Default is DENY: forgetting to enable spending
 * costs nothing, whereas forgetting to disable it costs money. That asymmetry
 * is the whole point, so do not invert it for convenience.
 *
 * Two independent switches, and BOTH must be on:
 *
 *   1. LLM_SPEND=allow in the environment — the standing permission a running
 *      app needs.
 *   2. requireExplicitApproval() — command-line tools additionally refuse
 *      unless --allow-spend was typed for that specific invocation, so a
 *      standing permission in .env.local cannot make a script spend silently.
 *
 * The second exists because the first is too easy to leave on.
 */

let scriptApproved: boolean | null = null;

/**
 * Call once at the top of any script that may reach a model. Reads
 * --allow-spend from argv and, when absent, revokes any standing permission
 * inherited from .env.local for this process only.
 */
export function requireExplicitApproval(argv: string[] = process.argv): boolean {
  scriptApproved = argv.includes("--allow-spend");
  if (!scriptApproved) {
    // A script that was not explicitly approved must not be able to spend, even
    // if the environment says otherwise.
    delete process.env.LLM_SPEND;
  }
  return scriptApproved;
}

export function spendAllowed(): boolean {
  if (scriptApproved === false) return false;
  return process.env.LLM_SPEND === "allow";
}

export class SpendBlockedError extends Error {
  constructor(stage: string) {
    super(
      [
        `Blocked before calling a model (stage: ${stage}). No tokens were used.`,
        "",
        "This is the default. To spend, both of these must be true:",
        "  1. LLM_SPEND=allow is set in the environment (or .env.local)",
        "  2. the command was run with --allow-spend",
        "",
        "e.g.  LLM_SPEND=allow npm run measure -- --allow-spend --posting <url> --cv <file>",
        "",
        "Free checks that never call a model:",
        "  npm test              45 assertions over scoring, grounding, layout",
        "  npm run check-routing  which model each stage would use",
        "  npm run check-grounding  quote grounder, both directions",
      ].join("\n"),
    );
    this.name = "SpendBlockedError";
  }
}

/** Throws unless spending has been approved. Called on every model call. */
export function assertSpendAllowed(stage: string): void {
  if (!spendAllowed()) throw new SpendBlockedError(stage);
}
