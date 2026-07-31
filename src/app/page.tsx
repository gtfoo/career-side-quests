import { PRODUCT } from "@/config/product";
import { StartForm } from "./StartForm";

export default function Home() {
  return (
    <main className="mx-auto max-w-[1000px] px-6 pb-24">
      <header className="flex items-center justify-between gap-4 py-5">
        <span className="font-mono text-xs font-semibold uppercase tracking-[0.3em]">
          {PRODUCT.name}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-faint)]">
          Assessment only · nothing is kept
        </span>
      </header>

      <div className="flex flex-col gap-3 pb-8 pt-6">
        <h1 className="max-w-[18ch] text-balance font-serif text-5xl font-semibold leading-[1.08]">
          Where do you actually stand?
        </h1>
        <p className="max-w-[54ch] text-[17px] text-[var(--color-muted)]">
          Tell me the role you&rsquo;re after and what you&rsquo;ve got. You&rsquo;ll
          get an honest read on the distance, and the shortest route across it.
        </p>
      </div>

      <StartForm />
    </main>
  );
}
