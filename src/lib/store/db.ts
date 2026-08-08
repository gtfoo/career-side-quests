import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

/**
 * The one SQLite connection, and the schema it owns.
 *
 * SQLite rather than a server database because the droplet is RAM-bound —
 * ~490MB free across three Next apps — and this runs in-process with no daemon.
 * carpark-sg already proves the same dependency compiles and runs there.
 *
 * What is deliberately NOT stored: uploaded files, full CV text, and provider
 * access tokens. Identity is all the app needs, and the quotes it keeps are
 * only those required to render a citation. See AGENTS.md.
 */

/**
 * Resolved lazily, NOT at module load.
 *
 * As a module-level const this silently ignored any later DB_PATH change,
 * because the import ran first — so the test suite pointed at a scratch file
 * and wrote to the real development database anyway. The tests passed; they
 * were simply testing the wrong file.
 */
function dbPath(): string {
  return process.env.DB_PATH ?? join(process.cwd(), "data", "app.db");
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);

  // WAL lets reads proceed during a write, which matters on one small box
  // where a build or a slow read should not block the login flow.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE,
      name          TEXT,
      image         TEXT,
      email_verified TEXT,
      -- Bumping this invalidates every existing JWT for the user, which is how
      -- "sign out everywhere" works without storing sessions server-side.
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider           TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      type               TEXT NOT NULL,
      PRIMARY KEY (provider, provider_account_id)
    );

    -- Passkeys. The public key is stored; the private key never leaves the
    -- user's device, which is the whole point of the mechanism.
    CREATE TABLE IF NOT EXISTS authenticators (
      credential_id           TEXT PRIMARY KEY,
      user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_account_id     TEXT NOT NULL,
      credential_public_key   TEXT NOT NULL,
      counter                 INTEGER NOT NULL,
      credential_device_type  TEXT NOT NULL,
      credential_backed_up    INTEGER NOT NULL,
      transports              TEXT,
      created_at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS authenticators_by_user ON authenticators(user_id);

    -- Magic-link tokens. Single use, short lived, and deleted on use.
    CREATE TABLE IF NOT EXISTS verification_tokens (
      identifier TEXT NOT NULL,
      token      TEXT NOT NULL,
      expires    TEXT NOT NULL,
      PRIMARY KEY (identifier, token)
    );

    CREATE TABLE IF NOT EXISTS reads (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at     TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      title          TEXT,
      verdict        TEXT,
      carries_over   INTEGER,
      target_json    TEXT NOT NULL,
      assessment_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reads_by_user ON reads(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS quest_progress (
      read_id      TEXT NOT NULL REFERENCES reads(id) ON DELETE CASCADE,
      milestone_id TEXT NOT NULL,
      done_at      TEXT NOT NULL,
      PRIMARY KEY (read_id, milestone_id)
    );
  `);

  return db;
}

/** Test hook: point at a scratch file and start clean. */
export function _resetForTests(path: string): void {
  db = null;
  process.env.DB_PATH = path;
}

// ------------------------------------------------------------------- users

export type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  token_version: number;
};

/**
 * The token version, or null when the user is gone.
 *
 * The distinction matters: null means the account was deleted, a number that
 * no longer matches means every session was revoked. Both invalidate a JWT, but
 * collapsing them into 0 would let a deleted account's token keep working.
 */
export function tokenVersion(id: string): number | null {
  const row = getDb()
    .prepare(`SELECT token_version FROM users WHERE id = ?`)
    .get(id) as { token_version: number } | undefined;
  return row ? row.token_version : null;
}

export function getUserById(id: string): UserRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, email, name, image, token_version FROM users WHERE id = ?`,
    )
    .get(id) as UserRow | undefined;
}

export function touchUser(id: string): void {
  getDb()
    .prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

/** Invalidate every session for a user — the kill switch after a leak. */
export function bumpTokenVersion(id: string): void {
  getDb()
    .prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`)
    .run(id);
}

// ------------------------------------------------------------------- reads

/** How long a saved read lives before it expires on its own. */
export const RETENTION_DAYS = 180;

export type SavedRead = {
  id: string;
  created_at: string;
  expires_at: string;
  title: string | null;
  verdict: string | null;
  carries_over: number | null;
};

export function saveRead(args: {
  userId: string;
  title: string | null;
  verdict: string | null;
  carriesOver: number | null;
  target: unknown;
  assessment: unknown;
}): string {
  const id = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + RETENTION_DAYS * 86_400_000);

  getDb()
    .prepare(
      `INSERT INTO reads
         (id, user_id, created_at, expires_at, title, verdict, carries_over,
          target_json, assessment_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.userId,
      now.toISOString(),
      expires.toISOString(),
      args.title,
      args.verdict,
      args.carriesOver,
      JSON.stringify(args.target),
      JSON.stringify(args.assessment),
    );
  return id;
}

export function listReads(userId: string): SavedRead[] {
  return getDb()
    .prepare(
      `SELECT id, created_at, expires_at, title, verdict, carries_over
         FROM reads WHERE user_id = ? AND expires_at > ?
        ORDER BY created_at DESC`,
    )
    .all(userId, new Date().toISOString()) as SavedRead[];
}

/**
 * Always filtered by user_id, never by id alone. A read belongs to exactly one
 * account, and an id guessed or leaked from elsewhere must not be enough to
 * fetch someone's assessment.
 */
export function getRead(
  userId: string,
  readId: string,
): { target: unknown; assessment: unknown } | undefined {
  const row = getDb()
    .prepare(
      `SELECT target_json, assessment_json FROM reads
        WHERE id = ? AND user_id = ? AND expires_at > ?`,
    )
    .get(readId, userId, new Date().toISOString()) as
    | { target_json: string; assessment_json: string }
    | undefined;
  if (!row) return undefined;
  return {
    target: JSON.parse(row.target_json),
    assessment: JSON.parse(row.assessment_json),
  };
}

/** Returns how many rows went, so a caller can tell "deleted" from "not yours". */
export function deleteRead(userId: string, readId: string): number {
  return getDb()
    .prepare(`DELETE FROM reads WHERE id = ? AND user_id = ?`)
    .run(readId, userId).changes;
}

export function deleteAllReads(userId: string): number {
  return getDb().prepare(`DELETE FROM reads WHERE user_id = ?`).run(userId)
    .changes;
}

/** Remove the account and everything cascading from it. */
export function deleteAccount(userId: string): void {
  getDb().prepare(`DELETE FROM users WHERE id = ?`).run(userId);
}

/** Nightly sweep. Retention that is not enforced is not a retention policy. */
export function purgeExpired(): number {
  return getDb()
    .prepare(`DELETE FROM reads WHERE expires_at <= ?`)
    .run(new Date().toISOString()).changes;
}
