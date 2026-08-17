/**
 * Runs once when the server starts.
 *
 * Exists for one reason: the user-count file is otherwise only refreshed on
 * sign-in, so an app that nobody signs into after a deploy would show a stale
 * count — or none at all on a fresh box — on gtfoo.com/admin. Writing once at
 * startup makes the file appear without waiting for a user.
 *
 * The `nodejs` guard matters: this module is also loaded in the edge runtime,
 * where better-sqlite3 does not exist and importing it throws.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Imported lazily rather than at module scope so the edge runtime never
  // evaluates the native addon behind it.
  const { reportUserCounts } = await import("@/auth");
  reportUserCounts();
}
