import type { SourceDoc } from "./resume";

/**
 * Reading someone's public GitHub as evidence.
 *
 * The design decision that matters: this does NOT hand structured JSON to the
 * matcher. It renders the facts into a deterministic text document, which then
 * flows through exactly the same extraction and verbatim-quote checking as a
 * CV. That keeps the one invariant the whole app rests on — every claim quotes
 * a literal span of a real source — instead of carving out an exception for
 * data that happens to arrive as JSON.
 *
 * It is also deliberately unflattering. A CV says "proficient in Python"; the
 * language breakdown says the shipped product is JavaScript and the only Python
 * is a 4KB icon script. Surfacing that is the point — it is the counter-evidence
 * the scoring stage is required to look for, and it is invisible on a resume.
 *
 * Public API only, no auth required. Set GITHUB_TOKEN to lift the rate limit
 * from 60/hr to 5000/hr.
 */

const API = "https://api.github.com";

type Repo = {
  name: string;
  full_name: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  size: number;
  created_at: string;
  pushed_at: string;
  language: string | null;
  html_url: string;
  topics?: string[];
};

function headers(): HeadersInit {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "career-side-quests",
  };
  if (process.env.GITHUB_TOKEN) {
    h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

async function api<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { headers: headers() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Accepts a username, a profile URL, or a repo URL. */
export function parseGithubHandle(input: string): string | null {
  const s = input.trim().replace(/^@/, "");
  if (!s) return null;
  const m = s.match(/github\.com\/([^/\s?#]+)/i);
  const handle = m ? m[1] : s.includes("/") ? s.split("/")[0] : s;
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(handle ?? "")
    ? handle!
    : null;
}

function monthsSince(iso: string): number {
  return Math.round(
    (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24 * 30.4),
  );
}

function fmtBytes(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}MB`
    : n >= 1000
      ? `${Math.round(n / 1000)}KB`
      : `${n}B`;
}

/**
 * How long the repo was worked on. A repo created and last pushed the same day
 * is a weekend build; one with months between is something maintained. Both are
 * legitimate — but they are different claims, and only this distinguishes them.
 */
function activeSpan(repo: Repo): string {
  const days = Math.round(
    (new Date(repo.pushed_at).getTime() - new Date(repo.created_at).getTime()) /
      (1000 * 60 * 60 * 24),
  );
  if (days <= 1) return "created and last pushed the same day";
  if (days < 14) return `worked on over ${days} days`;
  if (days < 60) return `worked on over ~${Math.round(days / 7)} weeks`;
  return `maintained over ~${Math.round(days / 30.4)} months`;
}

export type GithubReadResult =
  | { ok: true; doc: SourceDoc; repoCount: number; handle: string }
  | { ok: false; message: string };

export async function readGithub(input: string): Promise<GithubReadResult> {
  const handle = parseGithubHandle(input);
  if (!handle) {
    return { ok: false, message: `"${input}" is not a GitHub username or URL.` };
  }

  const user = await api<{
    login: string;
    name: string | null;
    bio: string | null;
    public_repos: number;
    created_at: string;
  }>(`/users/${handle}`);

  if (!user) {
    return {
      ok: false,
      message: `No public GitHub account at "${handle}" — or the API rate limit was hit. Set GITHUB_TOKEN to raise it.`,
    };
  }

  const repos =
    (await api<Repo[]>(`/users/${handle}/repos?per_page=100&sort=pushed`)) ?? [];

  // Forks and archives are not evidence of building something. Keeping them
  // would inflate the picture in exactly the direction this app exists to
  // resist.
  const own = repos.filter((r) => !r.fork && !r.archived).slice(0, 12);

  const lines: string[] = [
    `GitHub profile: ${user.login}`,
    user.name ? `Name: ${user.name}` : null,
    user.bio ? `Bio: ${user.bio}` : null,
    `Public repositories: ${user.public_repos}. Account created ${user.created_at.slice(0, 10)}.`,
    "",
  ].filter((l): l is string => l !== null);

  if (!own.length) {
    lines.push("No original (non-fork, non-archived) public repositories.");
  }

  for (const repo of own) {
    const langs =
      (await api<Record<string, number>>(
        `/repos/${repo.full_name}/languages`,
      )) ?? {};
    const total = Object.values(langs).reduce((a, b) => a + b, 0);
    const breakdown = Object.entries(langs)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([lang, bytes]) =>
          `${lang} ${fmtBytes(bytes)} (${Math.round((bytes / total) * 100)}%)`,
      )
      .join(", ");

    lines.push(
      `Repository ${repo.name}: ${repo.description ?? "no description"}.`,
      `  Languages: ${breakdown || "none detected"}.`,
      `  Size ${fmtBytes(repo.size * 1024)}, ${repo.stargazers_count} stars, last pushed ${monthsSince(repo.pushed_at)} months ago, ${activeSpan(repo)}.`,
    );

    // The dominant language vs. everything else is the single most useful
    // counter-evidence signal available: it is how "I know Python" meets "the
    // shipped product is JavaScript".
    const [top] = Object.entries(langs).sort((a, b) => b[1] - a[1]);
    if (top && total > 0) {
      const share = Math.round((top[1] / total) * 100);
      if (share >= 60) {
        lines.push(
          `  This repository is predominantly ${top[0]} (${share}% of its code).`,
        );
      }
    }
    lines.push("");
  }

  const text = lines.join("\n").trim();

  return {
    ok: true,
    handle: user.login,
    repoCount: own.length,
    doc: {
      id: `github:${user.login}`,
      filename: `github.com/${user.login}`,
      text,
      pages: [{ page: 1, text, via: "text_layer" }],
      coverage: 1,
      needsVision: [],
    },
  };
}
