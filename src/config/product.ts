/**
 * The ONLY place the product is named.
 *
 * Everything user-facing reads from here, so a rename stays a one-file edit.
 * Keep the brand out of component names, file names, prompts, table names and
 * env vars — see AGENTS.md.
 */
export const PRODUCT = {
  name: "Career Side Quests",
  /** Short form for tight spaces (headers, tabs). */
  shortName: "Side Quests",
  tagline: "See exactly where you stand for the job you want.",
  host: "career-side-quests.gtfoo.com",
} as const;
