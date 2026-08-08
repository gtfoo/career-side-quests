import { redirect } from "next/navigation";
import {
  authConfigured,
  currentUser,
  passkeysConfigured,
  signIn,
} from "@/auth";
import { PRODUCT } from "@/config/product";

/**
 * Sign in.
 *
 * Buttons appear only for providers that are actually configured, so a missing
 * key is one fewer option rather than a dead button that errors on click.
 *
 * No passwords. "Forgot password" would have needed email anyway, so passwords
 * would have added hashing, reset tokens and credential-stuffing defence
 * without removing a single dependency.
 */
export default async function SignIn() {
  if (await currentUser()) redirect("/data");

  // Every provider also requires AUTH_SECRET, so a configured provider without
  // one is not usable and must not be offered.
  const ready = authConfigured();
  const hasGithub =
    ready && Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
  const hasGoogle =
    ready && Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  const hasEmail = ready && Boolean(process.env.AUTH_RESEND_KEY);
  const anyProvider = hasGithub || hasGoogle || hasEmail;

  return (
    <main className="mx-auto max-w-[520px] px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[var(--color-faint)]">
        {PRODUCT.name}
      </p>
      <h1 className="mt-4 font-serif text-3xl font-semibold">Sign in</h1>
      <p className="mt-3 text-[15px] text-[var(--color-muted)]">
        Only needed to keep a read across devices. Everything works without an
        account &mdash; your reads are saved in this browser either way.
      </p>

      {!anyProvider && (
        <p className="mt-8 border-l-2 border-[var(--color-gap)] bg-[var(--color-gap)]/8 p-4 text-sm">
          No sign-in method is configured on this server yet.
        </p>
      )}

      <div className="mt-8 flex flex-col gap-3">
        {hasGithub && (
          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: "/data" });
            }}
          >
            <button
              type="submit"
              className="w-full border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 font-mono text-xs uppercase tracking-wider hover:border-[var(--color-ink)]"
            >
              Continue with GitHub
            </button>
          </form>
        )}

        {hasGoogle && (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/data" });
            }}
          >
            <button
              type="submit"
              className="w-full border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 font-mono text-xs uppercase tracking-wider hover:border-[var(--color-ink)]"
            >
              Continue with Google
            </button>
          </form>
        )}

        {hasEmail && (
          <>
            {(hasGithub || hasGoogle) && (
              <div className="my-1 flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--color-rule)]" />
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-faint)]">
                  or
                </span>
                <span className="h-px flex-1 bg-[var(--color-rule)]" />
              </div>
            )}
            <form
              action={async (formData: FormData) => {
                "use server";
                await signIn("resend", {
                  email: String(formData.get("email") ?? ""),
                  redirectTo: "/data",
                });
              }}
              className="flex flex-col gap-2"
            >
              <input
                type="email"
                name="email"
                required
                placeholder="you@example.com"
                className="border border-[var(--color-rule)] bg-[var(--color-sunken)] px-3 py-3 text-sm outline-none focus:border-[var(--color-carry)]"
              />
              <button
                type="submit"
                className="border border-[var(--color-ink)] bg-[var(--color-ink)] px-4 py-3 font-mono text-xs uppercase tracking-wider text-[var(--color-paper)] hover:opacity-85"
              >
                Email me a sign-in link
              </button>
              <span className="font-mono text-[11px] text-[var(--color-faint)]">
                No password. The link works once and expires in 15 minutes.
              </span>
            </form>
          </>
        )}

        {passkeysConfigured() && (
          <form
            action={async () => {
              "use server";
              await signIn("passkey", { redirectTo: "/data" });
            }}
          >
            <button
              type="submit"
              className="w-full border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3 font-mono text-xs uppercase tracking-wider hover:border-[var(--color-ink)]"
            >
              Use a passkey
            </button>
            {/* Stated because the distinction is easy to get wrong: a passkey
                lives on THIS device. It is a shortcut back in, not a way onto
                a machine you have never used. */}
            <span className="mt-1.5 block font-mono text-[11px] text-[var(--color-faint)]">
              For a device you&rsquo;ve already set one up on. Email works
              anywhere.
            </span>
          </form>
        )}
      </div>

      <p className="mt-10 border-t border-[var(--color-rule)] pt-4 text-[13px] leading-relaxed text-[var(--color-muted)]">
        Signing in stores your email address and any reads you choose to save.
        It does <strong>not</strong>
        {" upload your CV file — that stays in your browser. "}
        Saved reads expire after 180 days, and you can delete them at any time.
      </p>
    </main>
  );
}
