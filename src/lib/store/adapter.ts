import { randomUUID } from "node:crypto";
import type { Adapter, AdapterUser, VerificationToken } from "next-auth/adapters";
import { getDb } from "./db";

/**
 * A deliberately partial Auth.js adapter over SQLite.
 *
 * With the JWT session strategy, Auth.js never calls the session methods —
 * createSession, getSessionAndUser, updateSession, deleteSession — so they are
 * omitted rather than stubbed. Writing dead code that silently does nothing is
 * worse than not writing it: it looks like a session store and isn't one.
 *
 * What magic-link login actually needs is the verification-token pair plus
 * enough user methods to find or create an account for an email address.
 */
export function SqliteAdapter(): Adapter {
  return {
    async createUser(user) {
      const id = randomUUID();
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT INTO users (id, email, name, image, email_verified, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          user.email ?? null,
          user.name ?? null,
          user.image ?? null,
          user.emailVerified ? user.emailVerified.toISOString() : null,
          now,
          now,
        );
      return { ...user, id } as AdapterUser;
    },

    async getUser(id) {
      return toUser(
        getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id),
      );
    },

    async getUserByEmail(email) {
      return toUser(
        getDb().prepare(`SELECT * FROM users WHERE email = ?`).get(email),
      );
    },

    async getUserByAccount({ provider, providerAccountId }) {
      return toUser(
        getDb()
          .prepare(
            `SELECT u.* FROM users u
               JOIN accounts a ON a.user_id = u.id
              WHERE a.provider = ? AND a.provider_account_id = ?`,
          )
          .get(provider, providerAccountId),
      );
    },

    async updateUser(user) {
      getDb()
        .prepare(
          `UPDATE users
              SET name = COALESCE(?, name),
                  email = COALESCE(?, email),
                  image = COALESCE(?, image),
                  email_verified = COALESCE(?, email_verified),
                  last_seen_at = ?
            WHERE id = ?`,
        )
        .run(
          user.name ?? null,
          user.email ?? null,
          user.image ?? null,
          user.emailVerified ? user.emailVerified.toISOString() : null,
          new Date().toISOString(),
          user.id,
        );
      return (await this.getUser!(user.id!)) as AdapterUser;
    },

    async deleteUser(id) {
      // Cascades to accounts, reads and quest progress via foreign keys.
      getDb().prepare(`DELETE FROM users WHERE id = ?`).run(id);
    },

    /**
     * Only identity is recorded — no access token, no refresh token, no scope.
     * The app never acts on a user's behalf at a provider, so storing a
     * credential would be liability without purpose.
     */
    async linkAccount(account) {
      getDb()
        .prepare(
          `INSERT OR IGNORE INTO accounts (user_id, provider, provider_account_id, type)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          account.userId,
          account.provider,
          account.providerAccountId,
          account.type,
        );
      return undefined;
    },

    async unlinkAccount({ provider, providerAccountId }) {
      getDb()
        .prepare(
          `DELETE FROM accounts WHERE provider = ? AND provider_account_id = ?`,
        )
        .run(provider, providerAccountId);
    },

    async createVerificationToken(token) {
      getDb()
        .prepare(
          `INSERT INTO verification_tokens (identifier, token, expires) VALUES (?, ?, ?)`,
        )
        .run(token.identifier, token.token, token.expires.toISOString());
      return token;
    },

    /**
     * Single use: the row is deleted as it is read, inside a transaction, so a
     * magic link cannot be replayed even if the email is forwarded or the URL
     * ends up in a proxy log. Expiry is checked by the caller; the row is
     * consumed either way so a stale link cannot be retried.
     */
    async useVerificationToken({ identifier, token }) {
      const db = getDb();
      const consume = db.transaction(() => {
        const row = db
          .prepare(
            `SELECT identifier, token, expires FROM verification_tokens
              WHERE identifier = ? AND token = ?`,
          )
          .get(identifier, token) as
          | { identifier: string; token: string; expires: string }
          | undefined;
        if (!row) return null;
        db.prepare(
          `DELETE FROM verification_tokens WHERE identifier = ? AND token = ?`,
        ).run(identifier, token);
        return {
          identifier: row.identifier,
          token: row.token,
          expires: new Date(row.expires),
        } satisfies VerificationToken;
      });
      return consume();
    },
  };
}

type Row = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  email_verified: string | null;
};

function toUser(row: unknown): AdapterUser | null {
  const r = row as Row | undefined;
  if (!r) return null;
  return {
    id: r.id,
    email: r.email ?? "",
    name: r.name,
    image: r.image,
    emailVerified: r.email_verified ? new Date(r.email_verified) : null,
  };
}
