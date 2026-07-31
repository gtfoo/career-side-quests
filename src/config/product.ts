/**
 * The ONLY place the product is named.
 *
 * The name is still undecided, so everything user-facing reads from here and
 * renaming stays a one-file edit. Keep the brand out of component names, file
 * names, prompts, table names and env vars — see AGENTS.md.
 */
export const PRODUCT = {
  name: "Role Match",
  tagline: "See exactly where you stand for the job you want.",
} as const;
