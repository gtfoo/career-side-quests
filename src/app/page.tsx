import { PRODUCT } from "@/config/product";

/**
 * Placeholder shell. The real input screen and read screens land next; this
 * exists so the app builds and runs while the pipeline is wired up.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-[var(--color-faint)]">
        {PRODUCT.name}
      </p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance">
        {PRODUCT.tagline}
      </h1>
      <p className="mt-6 max-w-[60ch] text-[var(--color-muted)]">
        The assessment pipeline is wired up and runs from the command line.
        The web input screen is next.
      </p>

      <div className="mt-10 border border-[var(--color-rule)] bg-[var(--color-surface)] p-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
          Run a read now
        </p>
        <pre className="mt-3 overflow-x-auto text-sm">
          <code>npm run spike -- --posting &lt;url&gt; --cv &lt;file.pdf&gt;</code>
        </pre>
      </div>
    </main>
  );
}
