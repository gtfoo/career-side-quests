/**
 * Device-local persistence.
 *
 * Everything here stays in the browser. Nothing is sent anywhere, which is why
 * this can ship before any account system exists and why the disclosure at the
 * upload control can say, truthfully, that the file never leaves the device.
 *
 * The problem it solves is not subtle: before this, a browser refresh destroyed
 * an entire read — the uploaded CV, the resolved posting, the scores, the
 * ticked milestones. That is a bad outcome for a page people leave open next to
 * a job posting they are reading.
 *
 * Two rules:
 *  - Storage failures must never break the app. Private mode, disabled storage
 *    and full quotas all throw, and none of them are a reason to lose the page.
 *  - The key is versioned. A shape change should orphan old data rather than
 *    hydrate a stale object into a component that no longer understands it.
 */

const KEY = "csq.v1";

/** Bumped when the persisted shape changes incompatibly. */
const VERSION = 1;

export type StoredDoc = {
  /** Present on server-parsed docs; absent on ones the client built. */
  id?: string;
  filename: string;
  pages: number;
  coverage: number;
  needsVision: number[];
  chars: number;
  notice: string | null;
  text: string;
};

export type StoredSnapshot = {
  title: string | null;
  locations: string[];
  fidelity: string;
  text: string;
  capturedAt: string;
};

export type StoredState = {
  version: number;
  savedAt: string;
  /** What the user was in the middle of. */
  mode?: string;
  url?: string;
  pasted?: string;
  roleText?: string;
  snapshot?: StoredSnapshot | null;
  docs?: StoredDoc[];
  links?: Record<string, string>;
  notes?: string;
  /** A completed read, so results survive a refresh too. */
  result?: unknown;
  /** Milestone ids the user has ticked. */
  progress?: string[];
};

/**
 * Whether persistence is actually available. Called before promising the user
 * anything in the UI — claiming "this stays on your device" while silently
 * failing to store it would be worse than not storing at all.
 */
export function isAvailable(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const probe = "__csq_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function load(): StoredState | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredState;
    // Orphan rather than migrate: a half-understood object is worse than a
    // clean start, and there is nothing here a user cannot regenerate.
    if (parsed?.version !== VERSION) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Does this state hold anything the user would care about losing?
 *
 * Used to decide whether the key should exist at all. Two reasons it matters,
 * and both are about keeping a promise rather than saving bytes:
 *
 *  - Merely opening the page must not create a storage entry. Writing an empty
 *    skeleton the moment someone arrives is storage they never asked for.
 *  - "Delete everything on this device" must leave nothing behind. The save
 *    effect fires immediately after a clear, so without this it would rewrite
 *    a hollow object one tick later and the key would reappear.
 */
function hasContent(s: StoredState): boolean {
  return Boolean(
    s.url?.trim() ||
      s.pasted?.trim() ||
      s.roleText?.trim() ||
      s.notes?.trim() ||
      s.snapshot ||
      s.result ||
      s.docs?.length ||
      s.progress?.length ||
      Object.values(s.links ?? {}).some((v) => v.trim()),
  );
}

export function save(patch: Partial<StoredState>): void {
  try {
    if (typeof window === "undefined") return;
    const current = load() ?? { version: VERSION, savedAt: "" };
    const next: StoredState = {
      ...current,
      ...patch,
      version: VERSION,
      savedAt: new Date().toISOString(),
    };
    if (!hasContent(next)) {
      window.localStorage.removeItem(KEY);
      return;
    }
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded, private mode, storage disabled. The page keeps working
    // from React state; only persistence is lost, and the UI says so.
  }
}

export function clear(): void {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** Roughly how much has been stored, for the "what's kept" disclosure. */
export function storedSize(): number {
  try {
    if (typeof window === "undefined") return 0;
    return window.localStorage.getItem(KEY)?.length ?? 0;
  } catch {
    return 0;
  }
}
