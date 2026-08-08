import { getDb } from "./db";

/**
 * The passkeys someone has registered, for showing and removing.
 *
 * Auth.js's adapter can list them, but it returns the credential material —
 * public key, counter, transports — which a page has no business carrying to
 * the browser. This returns only what a person needs to tell one device from
 * another and decide to revoke it.
 */
export type RegisteredPasskey = {
  /** Opaque id, used to revoke. Not secret: the private key never leaves the device. */
  credentialId: string;
  /** "multiDevice" for a synced passkey, "singleDevice" for one tied to hardware. */
  deviceType: string;
  /** Whether the authenticator reports it is backed up, i.e. synced. */
  backedUp: boolean;
  addedOn: string;
};

export function listPasskeys(userId: string): RegisteredPasskey[] {
  const rows = getDb()
    .prepare(
      `SELECT credential_id, credential_device_type, credential_backed_up, created_at
         FROM authenticators WHERE user_id = ? ORDER BY created_at`,
    )
    .all(userId) as {
    credential_id: string;
    credential_device_type: string;
    credential_backed_up: number;
    created_at: string;
  }[];

  return rows.map((r) => ({
    credentialId: r.credential_id,
    deviceType: r.credential_device_type,
    backedUp: Boolean(r.credential_backed_up),
    // Date only. A time implies a precision nobody needs here.
    addedOn: r.created_at.slice(0, 10),
  }));
}

/**
 * Revoke one.
 *
 * Scoped by user, so a credential id belonging to someone else matches nothing.
 * Without this a passkey on a lost laptop stays valid forever, which is not a
 * defensible thing to ship as a way of signing in.
 */
export function removePasskey(userId: string, credentialId: string): boolean {
  return (
    getDb()
      .prepare(
        `DELETE FROM authenticators WHERE user_id = ? AND credential_id = ?`,
      )
      .run(userId, credentialId).changes > 0
  );
}

/** Does this account have any passkey at all? Decides what the UI offers. */
export function hasPasskeys(userId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM authenticators WHERE user_id = ? LIMIT 1`)
    .get(userId);
  return Boolean(row);
}
