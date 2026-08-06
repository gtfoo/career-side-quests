import { authConfigured, handlers } from "@/auth";
import { LIMITS, check, clientKey, tooMany } from "@/lib/ratelimit";

/**
 * Auth.js mounts its own routes here (sign-in, callback, session, sign-out).
 *
 * Accounts are optional in this app, but Auth.js throws MissingSecret on any
 * request — including a plain session read — when AUTH_SECRET is unset. So the
 * route answers 404 until sign-in is actually configured: an unconfigured
 * optional feature should be absent, not loudly broken.
 *
 * Rate limiting for the email sign-in POST lives here rather than inside
 * Auth.js, because the library owns everything past this point and that request
 * sends mail to a caller-supplied address.
 */
const notConfigured = () =>
  new Response(
    JSON.stringify({ ok: false, message: "Sign-in is not configured." }),
    { status: 404, headers: { "content-type": "application/json" } },
  );

type AuthRequest = Parameters<typeof handlers.POST>[0];

export async function GET(request: AuthRequest) {
  if (!authConfigured()) return notConfigured();
  return handlers.GET(request);
}

export async function POST(request: AuthRequest) {
  if (!authConfigured()) return notConfigured();

  // Only the email path sends mail; OAuth POSTs are cheap and should not be
  // throttled alongside it.
  if (new URL(request.url).pathname.includes("/signin/resend")) {
    const result = check(clientKey(request, "signin"), LIMITS.signin);
    if (!result.ok) return tooMany(result, "sign-in attempts");
  }
  return handlers.POST(request);
}
