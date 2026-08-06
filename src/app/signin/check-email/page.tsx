import { PRODUCT } from "@/config/product";

/** Shown after a magic link is sent. Auth.js routes here via `verifyRequest`. */
export default function CheckEmail() {
  return (
    <main className="mx-auto max-w-[520px] px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[var(--color-faint)]">
        {PRODUCT.name}
      </p>
      <h1 className="mt-4 font-serif text-3xl font-semibold">Check your email</h1>
      <p className="mt-3 text-[15px] text-[var(--color-muted)]">
        We&rsquo;ve sent you a sign-in link. It works once and expires in 15
        minutes.
      </p>
      <p className="mt-6 text-[13px] leading-relaxed text-[var(--color-muted)]">
        Nothing arriving? Check spam, and confirm the address was right &mdash;
        we can&rsquo;t tell you whether an address exists, because that would
        let anyone use this page to test which emails are registered.
      </p>
      <a
        href="/signin"
        className="mt-8 inline-block border border-[var(--color-rule)] px-4 py-2 font-mono text-[11px] uppercase tracking-wider hover:border-[var(--color-ink)]"
      >
        Try a different address
      </a>
    </main>
  );
}
