"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/webauthn";
import type { RegisteredPasskey } from "@/lib/store/passkeys";

/**
 * The passkeys on this account: what is registered, add this device, revoke one.
 *
 * A client component because WebAuthn is a browser ceremony — the platform
 * prompt is raised by `navigator.credentials`, which no server action can do.
 * `next-auth/webauthn` drives all of it, so this is a button rather than a
 * WebAuthn implementation.
 *
 * Registering lives HERE, behind a session, and never on the sign-in page. A
 * passkey must not be able to create an account on its own — see the
 * `getUserInfo` override in src/auth.ts. The sign-in page only authenticates
 * one that already exists.
 */
export function Passkeys({ rows }: { rows: RegisteredPasskey[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistically hidden, restored if the delete fails — a revoke that appears
  // to do nothing for a second reads as broken on the one screen where people
  // are already nervous.
  const [gone, setGone] = useState<string[]>([]);

  /** Cancelling the platform prompt throws too, and reporting that as an error is noise. */
  function report(err: unknown) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError" || name === "AbortError") return;
    setError(err instanceof Error ? err.message : "Something went wrong.");
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await signIn("passkey", { action: "register", redirectTo: "/data" });
      router.refresh();
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(credentialId: string) {
    setGone((g) => [...g, credentialId]);
    setError(null);
    try {
      const res = await fetch("/api/passkeys", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentialId }),
      });
      if (!res.ok) throw new Error("Could not remove that passkey.");
      router.refresh();
    } catch (err) {
      setGone((g) => g.filter((c) => c !== credentialId));
      report(err);
    }
  }

  const visible = rows.filter((r) => !gone.includes(r.credentialId));

  return (
    <section className="border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
      <h2 className="font-serif text-xl font-semibold">Passkeys</h2>
      <p className="mt-1 max-w-[60ch] text-sm text-[var(--color-muted)]">
        A shortcut back into a device you already use &mdash; your fingerprint or
        face instead of an email round trip. It does{" "}
        <strong>not</strong> get you onto a new device, so the sign-in link is
        never optional.
      </p>

      {visible.length > 0 && (
        <ul className="mt-4 flex flex-col border-y border-[var(--color-rule)]">
          {visible.map((row) => (
            <li
              key={row.credentialId}
              className="flex items-baseline justify-between gap-4 border-b border-[var(--color-rule)]/60 py-2.5 last:border-b-0"
            >
              <span className="text-sm">
                {/* Synced vs hardware-bound is the difference between "this is
                    on all my Apple devices" and "this is on this laptop only",
                    which is what someone needs to decide whether to revoke. */}
                {row.backedUp ? "Synced passkey" : "This device only"}
                <small className="mt-0.5 block font-mono text-[11px] text-[var(--color-faint)]">
                  added {row.addedOn}
                </small>
              </span>
              <button
                type="button"
                onClick={() => remove(row.credentialId)}
                className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)] underline underline-offset-2 hover:text-[var(--color-block)]"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Still offered once one exists: a phone and a laptop are different
          credentials, and registering the second is most of the point. */}
      <button
        type="button"
        onClick={add}
        disabled={busy}
        className="mt-4 border border-[var(--color-rule)] px-4 py-2 font-mono text-[10px] uppercase tracking-wider hover:border-[var(--color-ink)] disabled:opacity-50"
      >
        {busy
          ? "Waiting for your device…"
          : visible.length
            ? "Add another device"
            : "Set up a passkey on this device"}
      </button>

      {error && (
        <p className="mt-3 border-l-2 border-[var(--color-block)] pl-3 text-sm text-[var(--color-block)]">
          {error}
        </p>
      )}
    </section>
  );
}
