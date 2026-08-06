/**
 * A small in-memory rate limiter.
 *
 * Two things need one, for different reasons:
 *
 *  - `/api/assess` costs roughly $0.50 per call in model tokens. A public URL
 *    with no limit is an open tap into someone's provider balance.
 *  - Magic-link sign-in sends email to an address the caller supplies. Without
 *    a limit that is a way to send mail to strangers using our domain's
 *    reputation, which is how a sending domain gets blocklisted.
 *
 * In-memory rather than Redis: one droplet, one process, ~490MB free. A shared
 * store would be correct across replicas and this app has none. Counters reset
 * on restart, which is an acceptable trade for not running another daemon.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Stop the map growing without bound on a long-lived process. */
function sweep(now: number): void {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

export type Limit = { limit: number; windowMs: number };

export const LIMITS = {
  /** Expensive: a full read is ~10 model calls. */
  assess: { limit: 5, windowMs: 60 * 60 * 1000 },
  /** Sends email to a caller-supplied address. */
  signin: { limit: 5, windowMs: 15 * 60 * 1000 },
  /** Cheap but not free — hits the GitHub API. */
  ingest: { limit: 30, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, Limit>;

export type RateResult = {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function check(key: string, limit: Limit): RateResult {
  const now = Date.now();
  sweep(now);

  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { ok: true, remaining: limit.limit - 1, retryAfterSeconds: 0 };
  }

  b.count++;
  const ok = b.count <= limit.limit;
  return {
    ok,
    remaining: Math.max(0, limit.limit - b.count),
    retryAfterSeconds: ok ? 0 : Math.ceil((b.resetAt - now) / 1000),
  };
}

/**
 * Who is calling. Behind Caddy the socket address is always localhost, so the
 * forwarded header is the only real signal — and it is caller-supplied, so it
 * is a speed bump rather than a security control. Anything that must not be
 * bypassed belongs behind authentication, not behind this.
 */
export function clientKey(request: Request, scope: string): string {
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || "unknown";
  return `${scope}:${ip}`;
}

/** A 429 with the header clients actually look at. */
export function tooMany(result: RateResult, what: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      message: `Too many ${what}. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.retryAfterSeconds),
      },
    },
  );
}

/** Test hook. */
export function _clear(): void {
  buckets.clear();
}
