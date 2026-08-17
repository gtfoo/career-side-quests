import type { NextRequest } from "next/server";
import { currentUser, passkeysConfigured } from "@/auth";
import { removePasskey } from "@/lib/store/passkeys";

/**
 * Revoke a passkey.
 *
 * Only ever your own. The owner comes from the session and is passed to the
 * DELETE as a scope, so a credential id belonging to someone else matches
 * nothing — the request cannot name whose passkey to remove.
 *
 * This endpoint is why offering passkeys is defensible at all: a way of signing
 * in that cannot be revoked from a device you no longer have is not one worth
 * shipping.
 */
export async function DELETE(req: NextRequest) {
  // 404 rather than 403 when the feature is off: an endpoint that exists only
  // when a flag is set should not confirm the flag's state.
  if (!passkeysConfigured()) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const user = await currentUser();
  if (!user) return Response.json({ error: "not signed in" }, { status: 401 });

  let credentialId = "";
  try {
    const body = (await req.json()) as { credentialId?: string };
    credentialId = (body.credentialId ?? "").trim();
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }
  if (!credentialId) {
    return Response.json({ error: "credentialId is required" }, { status: 400 });
  }

  const removed = removePasskey(user.id, credentialId);
  if (!removed) return Response.json({ error: "no such passkey" }, { status: 404 });
  return Response.json({ ok: true });
}
