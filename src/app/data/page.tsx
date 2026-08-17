import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, passkeysConfigured, signOut } from "@/auth";
import { PRODUCT } from "@/config/product";
import { listReads, deleteAllReads } from "@/lib/store/db";
import { listPasskeys } from "@/lib/store/passkeys";
import { Passkeys } from "./Passkeys";

/**
 * Your account.
 *
 * This route already existed as a promise: every `signIn` on the sign-in page
 * redirects here, and nothing was at the other end — so a successful sign-in,
 * magic link included, landed on a 404. That is what this page fixes first.
 *
 * It is also the only place a passkey may be REGISTERED, because registering
 * requires a session. The sign-in page can authenticate a passkey that already
 * exists; it must never be able to mint an account from one.
 *
 * What lives here is what the sign-in page promises: the email we hold, the
 * reads you chose to save, and a way to delete either. A page that claims
 * "delete at any time" without offering it is a worse lie than not claiming it.
 */
export default async function DataPage() {
  const user = await currentUser();
  if (!user) redirect("/signin");

  const reads = listReads(user.id);
  const passkeys = passkeysConfigured() ? listPasskeys(user.id) : [];

  return (
    <main className="mx-auto flex max-w-[720px] flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-1">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--color-faint)] hover:text-[var(--color-ink)]"
        >
          {PRODUCT.name}
        </Link>
        <h1 className="mt-3 font-serif text-3xl font-semibold">Your account</h1>
        <p className="font-mono text-xs text-[var(--color-muted)]">{user.email}</p>
      </header>

      {passkeysConfigured() ? (
        <Passkeys rows={passkeys} />
      ) : (
        <section className="border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
          <h2 className="font-serif text-xl font-semibold">Passkeys</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Not enabled on this server. Sign-in links still work everywhere.
          </p>
        </section>
      )}

      <section className="border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
        <h2 className="font-serif text-xl font-semibold">Saved reads</h2>
        <p className="mt-1 max-w-[60ch] text-sm text-[var(--color-muted)]">
          {reads.length === 0
            ? "None saved to your account. Reads stay in this browser unless you save them."
            : `${reads.length} saved. They expire on their own after 180 days.`}
        </p>

        {reads.length > 0 && (
          <>
            <ul className="mt-4 flex flex-col border-y border-[var(--color-rule)]">
              {reads.slice(0, 8).map((r) => (
                <li
                  key={r.id}
                  className="flex items-baseline justify-between gap-4 border-b border-[var(--color-rule)]/60 py-2.5 last:border-b-0"
                >
                  <span className="text-sm">{r.title}</span>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--color-faint)]">
                    {r.created_at.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
            <form
              action={async () => {
                "use server";
                const u = await currentUser();
                // Re-read the session inside the action. The id in the closure
                // was captured at render and must not be what authorises a
                // delete.
                if (u) deleteAllReads(u.id);
                redirect("/data");
              }}
            >
              <button
                type="submit"
                className="mt-4 border border-[var(--color-rule)] px-4 py-2 font-mono text-[10px] uppercase tracking-wider hover:border-[var(--color-block)] hover:text-[var(--color-block)]"
              >
                Delete every saved read
              </button>
            </form>
          </>
        )}
      </section>

      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button
          type="submit"
          className="border border-[var(--color-rule)] px-4 py-2 font-mono text-[10px] uppercase tracking-wider hover:border-[var(--color-ink)]"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
