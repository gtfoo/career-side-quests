import type { Fidelity } from "@/lib/schema";

/**
 * Fetching a job posting.
 *
 * Two hard-won rules live here:
 *
 * 1. SNAPSHOT AT INGEST, never re-fetch for display. Postings are pulled within
 *    weeks — a report that dies with the posting is worthless, and a build
 *    someone started against it is worse than worthless.
 *
 * 2. A posting missing from a board API does NOT mean it is closed. Boards
 *    paginate, filter by visibility, and omit postings the public page still
 *    serves. Absence from a list is "unknown", never "gone" — only the
 *    canonical page 404ing is evidence of that.
 */

export type PostingSnapshot = {
  sourceUrl: string;
  fidelity: Fidelity;
  /** The raw JD text, exactly as fetched. Every quote is checked against this. */
  text: string;
  title: string | null;
  company: string | null;
  locations: string[];
  capturedAt: string;
  /**
   * The board's own id for this posting. Matching on this is the ONLY reliable
   * way to pick the right one out of a feed — see the note in fetchPosting().
   */
  postingId: string | null;
};

/** Ashby, Greenhouse and Lever all publish clean unauthenticated JSON. */
type BoardAdapter = {
  name: string;
  /** Does this URL belong to this board? */
  matches: (url: URL) => boolean;
  /** Pull the org slug and posting id out of the URL. */
  parse: (url: URL) => { org: string; id: string | null } | null;
  boardUrl: (org: string) => string;
  /** Normalise this board's JSON into snapshots. */
  extract: (json: unknown) => PostingSnapshot[];
};

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const ashby: BoardAdapter = {
  name: "ashby",
  matches: (url) =>
    url.hostname.includes("ashbyhq.com") || url.searchParams.has("ashby_jid"),
  parse: (url) => {
    const jid = url.searchParams.get("ashby_jid");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname.includes("ashbyhq.com")) {
      // jobs.ashbyhq.com/<org>/<id>
      const [org, id] = parts;
      return org ? { org, id: jid ?? id ?? null } : null;
    }
    return null;
  },
  boardUrl: (org) =>
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`,
  extract: (json) => {
    const jobs = asArray((json as { jobs?: unknown })?.jobs);
    return jobs.flatMap((j) => {
      const job = j as Record<string, unknown>;
      const text = str(job.descriptionPlain);
      if (!text) return [];
      return [
        {
          sourceUrl: str(job.jobUrl) ?? "",
          fidelity: "posting" as const,
          text,
          title: str(job.title),
          company: null,
          locations: [
            str(job.location),
            ...asArray(job.secondaryLocations).map((l) =>
              str((l as Record<string, unknown>)?.location),
            ),
          ].filter((s): s is string => Boolean(s)),
          capturedAt: new Date().toISOString(),
          postingId: str(job.id),
        },
      ];
    });
  },
};

const greenhouse: BoardAdapter = {
  name: "greenhouse",
  matches: (url) => url.hostname.includes("greenhouse.io"),
  parse: (url) => {
    const parts = url.pathname.split("/").filter(Boolean);
    const org = parts.find((p) => p !== "embed" && p !== "jobs");
    const id = url.searchParams.get("gh_jid") ?? parts[parts.length - 1] ?? null;
    return org ? { org, id } : null;
  },
  boardUrl: (org) =>
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(org)}/jobs?content=true`,
  extract: (json) =>
    asArray((json as { jobs?: unknown })?.jobs).flatMap((j) => {
      const job = j as Record<string, unknown>;
      const raw = str(job.content);
      if (!raw) return [];
      return [
        {
          sourceUrl: str(job.absolute_url) ?? "",
          fidelity: "posting" as const,
          // Greenhouse returns HTML-escaped markup in a JSON string.
          text: stripHtml(decodeEntities(raw)),
          title: str(job.title),
          company: null,
          locations: [
            str((job.location as Record<string, unknown>)?.name),
          ].filter((s): s is string => Boolean(s)),
          capturedAt: new Date().toISOString(),
          postingId:
            str(job.id) ?? (typeof job.id === "number" ? String(job.id) : null),
        },
      ];
    }),
};

const lever: BoardAdapter = {
  name: "lever",
  matches: (url) => url.hostname.includes("lever.co"),
  parse: (url) => {
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[0] ? { org: parts[0], id: parts[1] ?? null } : null;
  },
  boardUrl: (org) =>
    `https://api.lever.co/v0/postings/${encodeURIComponent(org)}?mode=json`,
  extract: (json) =>
    asArray(json).flatMap((j) => {
      const job = j as Record<string, unknown>;
      const raw = str(job.descriptionPlain) ?? str(job.description);
      if (!raw) return [];
      return [
        {
          sourceUrl: str(job.hostedUrl) ?? "",
          fidelity: "posting" as const,
          text: stripHtml(raw),
          title: str(job.text),
          company: null,
          locations: [
            str((job.categories as Record<string, unknown>)?.location),
          ].filter((s): s is string => Boolean(s)),
          capturedAt: new Date().toISOString(),
          postingId: str(job.id),
        },
      ];
    }),
};

const ADAPTERS = [ashby, greenhouse, lever];

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripHtml(s: string): string {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type FetchOutcome =
  | { ok: true; snapshot: PostingSnapshot }
  | { ok: false; reason: "unsupported_board" | "not_found_in_board" | "error"; message: string };

/**
 * Fetch a posting by URL via its board's API.
 *
 * When the board responds but this posting is not in it, the result is
 * `not_found_in_board` — meaning "we could not confirm it", NOT "it is closed".
 * The caller should fall back to pasted text and say so, rather than telling
 * the user their posting is gone.
 */
export async function fetchPosting(rawUrl: string): Promise<FetchOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "error", message: "Not a valid URL." };
  }

  const adapter = ADAPTERS.find((a) => a.matches(url));
  if (!adapter) {
    return {
      ok: false,
      reason: "unsupported_board",
      message: `No adapter for ${url.hostname}. Paste the job description instead.`,
    };
  }

  const parsed = adapter.parse(url);
  if (!parsed) {
    return {
      ok: false,
      reason: "error",
      message: `Could not read an organisation from ${url.href}.`,
    };
  }

  try {
    const res = await fetch(adapter.boardUrl(parsed.org), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        message: `${adapter.name} board returned ${res.status}.`,
      };
    }
    const all = adapter.extract(await res.json());

    // Match on the board's OWN id, never on a substring of the URL we were
    // given. An earlier version fell back to `rawUrl.includes(id)`, which is
    // trivially true because the id was parsed OUT of that url — so .find()
    // returned the first posting in the feed for every input. It looked like it
    // worked: a real posting came back, with a title, and nothing errored. It
    // was simply the wrong job. If a future adapter cannot supply an id, fail
    // loudly rather than reintroducing a fuzzy match.
    if (!parsed.id) {
      return {
        ok: false,
        reason: "error",
        message:
          "No posting id in that URL. Open the posting itself and copy its full link, or paste the description.",
      };
    }

    const match = all.find((p) => p.postingId === parsed.id);

    if (!match) {
      return {
        ok: false,
        reason: "not_found_in_board",
        message:
          "That posting is not in the board feed. It may still be live — boards omit postings their public page serves. Paste the description to continue.",
      };
    }
    return { ok: true, snapshot: { ...match, sourceUrl: rawUrl } };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The escape hatch that must never break: user-pasted text. */
export function snapshotFromPaste(text: string, note?: string): PostingSnapshot {
  return {
    sourceUrl: note ?? "pasted",
    fidelity: "pasted",
    text,
    title: null,
    company: null,
    locations: [],
    capturedAt: new Date().toISOString(),
    postingId: null,
  };
}
