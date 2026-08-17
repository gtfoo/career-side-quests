"use client";

import { useState } from "react";
import { signIn } from "next-auth/webauthn";

/**
 * Sign in with a passkey already registered on this device.
 *
 * This was a server action calling `signIn("passkey")`, which cannot work:
 * WebAuthn is a browser ceremony, and the platform prompt comes from
 * `navigator.credentials` on the client. The button rendered, and clicking it
 * could never raise a prompt. `next-auth/webauthn` does the whole browser side
 * — fetch the options, prompt, post the result back — so this stays a button.
 *
 * `action: "authenticate"` is explicit. Registering must not happen here: a
 * passkey is not allowed to create an account, which is what the `getUserInfo`
 * override in src/auth.ts enforces. Adding one lives behind a session, on
 * /data.
 */
export function PasskeyButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await signIn("passkey", { action: "authenticate", redirectTo: "/data" });
    } catch (err) {
      // Dismissing the prompt throws as well, and telling someone something
      // went wrong because they changed their mind is noise.
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        setError(
          err instanceof Error && err.message
            ? err.message
            : "That passkey could not be used. Try the email link.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="w-full border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 font-mono text-xs uppercase tracking-wider hover:border-[var(--color-ink)] disabled:opacity-50"
      >
        {busy ? "Waiting for your device…" : "Use a passkey"}
      </button>
      {/* Stated because the distinction is easy to get wrong: a passkey lives
          on THIS device. It is a shortcut back in, not a way onto a machine you
          have never used. */}
      <span className="mt-1.5 block font-mono text-[11px] text-[var(--color-faint)]">
        For a device you&rsquo;ve already set one up on. Email works anywhere.
      </span>
      {error && (
        <p className="mt-2 border-l-2 border-[var(--color-block)] pl-3 text-sm text-[var(--color-block)]">
          {error}
        </p>
      )}
    </div>
  );
}
