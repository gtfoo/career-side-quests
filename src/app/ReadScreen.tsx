"use client";

import type { Assessment, JobTarget, Requirement } from "@/lib/schema";

/**
 * The read.
 *
 * The headline is a WORD, not a number. The percentage is real but demoted to a
 * split bar, because "84%" invites arguing with the number while "Stretch, one
 * gap short" invites doing something about it — and at a long distance a bare
 * percentage is just discouraging.
 *
 * Every level opens to show what it was based on, including the evidence that
 * cut against it. Showing the app's own doubts is what makes a low score
 * credible rather than insulting.
 */

export type ReadResult = {
  target: JobTarget;
  assessment: Assessment;
  models: Record<string, string>;
  flags: { stage: string; problem: string }[];
  fidelity: string;
  capturedAt: string;
};

const VERDICT_COPY: Record<string, { word: string; sub: string; tone: string }> = {
  lock: {
    word: "Lock",
    sub: "you meet the bar as stated",
    tone: "text-[var(--color-carry)]",
  },
  stretch: {
    word: "Stretch",
    sub: "not a lock, not a long shot",
    tone: "text-[var(--color-gap)]",
  },
  long_shot: {
    word: "Long shot",
    sub: "direct application is unlikely to land",
    tone: "text-[var(--color-block)]",
  },
};

const DISTANCE_COPY: Record<string, string> = {
  D0: "same job, same field",
  D1: "same job, new field",
  D2: "new job, same field",
  D3: "new job, new field",
  D4: "new field and new function",
};

const GAP_COPY: Record<string, { label: string; tone: string }> = {
  rewrite: { label: "Quick win", tone: "border-[var(--color-rule)]" },
  read: { label: "Read", tone: "border-[var(--color-rule)]" },
  drill: { label: "Drill", tone: "border-[var(--color-rule)]" },
  project: {
    label: "Build it",
    tone: "border-[var(--color-gap)] text-[var(--color-gap)]",
  },
  cannot_shortcut: {
    label: "Can't shortcut",
    tone: "border-[var(--color-block)] text-[var(--color-block)]",
  },
};

function Track({ level }: { level: number }) {
  return (
    <span className="grid grid-cols-3 gap-[3px]" aria-label={`${level} of 3`}>
      {[0, 1, 2].map((i) => (
        <i
          key={i}
          className={`block h-[7px] ${
            i < level
              ? "bg-[var(--color-carry)]"
              : "border border-[var(--color-gap)] bg-[repeating-linear-gradient(135deg,var(--color-gap)_0_2px,transparent_2px_5px)]"
          }`}
        />
      ))}
    </span>
  );
}

export function ReadScreen({
  result,
  onReset,
  onForget,
}: {
  result: ReadResult;
  onReset: () => void;
  /** Wipe everything held on this device, not just this read. */
  onForget?: () => void;
}) {
  const { target, assessment: a } = result;
  const verdict = VERDICT_COPY[a.verdict]!;
  const byId = new Map(target.requirements.map((r) => [r.id, r]));

  // Deliberately capped. An honest list of twelve is the same as no list —
  // people cannot act on twelve things, and pretending otherwise is how these
  // tools become demoralising rather than useful.
  const shown = a.gaps.slice(0, 6);
  const hidden = a.gaps.length - shown.length;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-faint)]">
            {target.title}
            {target.company ? ` — ${target.company}` : ""}
          </span>
          <h1 className="font-serif text-3xl font-semibold">Your read</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-[5px]">
            {(["D0", "D1", "D2", "D3", "D4"] as const).map((d) => (
              <i
                key={d}
                className={`block w-[26px] ${
                  d === a.distance
                    ? "h-[9px] bg-[var(--color-ink)]"
                    : "h-[5px] bg-[var(--color-rule)]"
                }`}
              />
            ))}
          </span>
          <span className="font-mono text-xs text-[var(--color-muted)]">
            Distance <b className="text-[var(--color-ink)]">{a.distance}</b> —{" "}
            {DISTANCE_COPY[a.distance]}
          </span>
        </div>
      </header>

      {/* ------------------------------------------------------- the verdict */}
      <section className="grid grid-cols-[300px_1fr] items-start gap-9">
        <div className="flex flex-col gap-4">
          <div>
            <div className={`font-serif text-5xl font-semibold ${verdict.tone}`}>
              {verdict.word}
            </div>
            <div className="font-mono text-xs text-[var(--color-muted)]">
              {verdict.sub}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex h-3 border border-[var(--color-rule)]">
              <i
                className="block bg-[var(--color-carry)]"
                style={{ width: `${a.carriesOver}%` }}
              />
              <i
                className="block bg-[repeating-linear-gradient(135deg,var(--color-gap)_0_2px,transparent_2px_6px)]"
                style={{ width: `${100 - a.carriesOver}%` }}
              />
            </div>
            <div className="flex justify-between font-mono text-[11px] tabular-nums">
              <span className="text-[var(--color-carry)]">
                {a.carriesOver}% carries over
              </span>
              <span className="text-[var(--color-gap)]">
                {100 - a.carriesOver}% to close
              </span>
            </div>
          </div>

          {a.eligibility.note && (
            <div
              className={`border-l-[3px] p-3 ${
                a.eligibility.clear
                  ? "border-[var(--color-carry)] bg-[var(--color-carry)]/8"
                  : "border-[var(--color-block)] bg-[var(--color-block)]/8"
              }`}
            >
              <span
                className={`font-mono text-[10px] uppercase tracking-wider ${
                  a.eligibility.clear
                    ? "text-[var(--color-carry)]"
                    : "text-[var(--color-block)]"
                }`}
              >
                Eligibility · {a.eligibility.clear ? "clear" : "blocked"}
              </span>
              <p className="mt-1 text-sm">{a.eligibility.note}</p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <p className="max-w-[60ch] font-serif text-xl leading-snug">
            {a.matches.filter((m) => m.level >= 3).length} of {a.matches.length}{" "}
            requirements are already evidenced.
          </p>
          <p className="max-w-[60ch] text-[var(--color-muted)]">
            {(() => {
              const movable = a.gaps.filter(
                (g) => g.kind !== "cannot_shortcut",
              ).length;
              const wording = a.gaps.filter((g) => g.kind === "rewrite").length;
              const stuck = a.gaps.filter(
                (g) => g.kind === "cannot_shortcut",
              ).length;
              if (!a.gaps.length) return "Nothing here needs closing.";
              const parts = [
                `${movable} of the rest ${movable === 1 ? "can" : "can"} be moved`,
              ];
              if (wording)
                parts.push(
                  `${wording} of those ${wording === 1 ? "is" : "are"} wording rather than capability`,
                );
              if (stuck)
                parts.push(
                  `${stuck} ${stuck === 1 ? "cannot" : "cannot"} be shortcut`,
                );
              return parts.join(", and ") + ".";
            })()}
          </p>
        </div>
      </section>

      {/* -------------------------------------------------------- the rubric */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-serif text-2xl font-semibold">How it scored</h2>
          <p className="max-w-[64ch] text-sm text-[var(--color-muted)]">
            Pulled from the posting itself. Open a row to see what the score was
            based on — and where the evidence pushes back.
          </p>
        </div>

        <div className="border border-[var(--color-rule)] bg-[var(--color-surface)]">
          {[...a.matches]
            .sort((x, y) => x.level - y.level)
            .map((m) => {
              const req: Requirement | undefined = byId.get(m.requirementId);
              return (
                <details
                  key={m.requirementId}
                  className="border-b border-[var(--color-rule)]/60 last:border-b-0"
                  open={m.level <= 1}
                >
                  <summary className="grid cursor-pointer list-none grid-cols-[40px_1fr_110px_58px] items-center gap-3 p-4 hover:bg-[var(--color-sunken)]">
                    <span className="font-mono text-[11px] text-[var(--color-faint)]">
                      {m.requirementId}
                    </span>
                    <span className="text-sm">
                      {req?.text ?? m.requirementId}
                      {req?.mustHave && (
                        <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-[var(--color-faint)]">
                          required
                        </span>
                      )}
                    </span>
                    <Track level={m.level} />
                    <span
                      className={`text-right font-mono text-[11px] ${
                        m.level >= 3
                          ? "text-[var(--color-muted)]"
                          : "text-[var(--color-gap)]"
                      }`}
                    >
                      <b>{m.level}</b>/3
                    </span>
                  </summary>

                  <div className="flex flex-col gap-3 px-4 pb-5 pl-[68px]">
                    {m.supporting.map((s, i) => (
                      <div
                        key={i}
                        className="border-l-2 border-[var(--color-rule)] pl-3.5"
                      >
                        <q className="block text-sm">{s.quote}</q>
                        <span className="mt-1 block font-mono text-[11px] text-[var(--color-faint)]">
                          your material · {s.atomId}
                        </span>
                      </div>
                    ))}
                    {m.counter.map((c, i) => (
                      <div
                        key={i}
                        className="border-l-2 border-[var(--color-gap)] pl-3.5"
                      >
                        <q className="block text-sm text-[var(--color-muted)]">
                          {c.observation}
                        </q>
                        <span className="mt-1 block font-mono text-[11px] text-[var(--color-gap)]">
                          pushback
                        </span>
                      </div>
                    ))}
                    <p className="max-w-[64ch] text-sm text-[var(--color-muted)]">
                      {m.reasoning}
                    </p>
                  </div>
                </details>
              );
            })}
        </div>
      </section>

      {/* ------------------------------------------------------ the gap list */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-serif text-2xl font-semibold">What to do</h2>
          <p className="max-w-[64ch] text-sm text-[var(--color-muted)]">
            Ranked by what actually moves the needle. Not every gap deserves a
            project — most don&rsquo;t.
          </p>
        </div>

        <div className="flex flex-col border border-[var(--color-rule)] bg-[var(--color-surface)]">
          {shown.map((g) => {
            const style = GAP_COPY[g.kind]!;
            return (
              <div
                key={g.requirementId}
                className="grid grid-cols-[1fr_120px_70px] items-center gap-4 border-b border-[var(--color-rule)]/60 p-4 last:border-b-0"
              >
                <span className="text-sm">
                  {g.what}
                  <small className="mt-0.5 block text-[13px] text-[var(--color-muted)]">
                    {g.why}
                  </small>
                </span>
                <span
                  className={`justify-self-start border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${style.tone}`}
                >
                  {style.label}
                </span>
                <span className="text-right font-mono text-xs text-[var(--color-muted)]">
                  {g.effortHours === null
                    ? "—"
                    : g.effortHours < 1
                      ? `${g.effortHours * 60} min`
                      : `~${g.effortHours} h`}
                </span>
              </div>
            );
          })}
          {hidden > 0 && (
            <div className="border-t border-[var(--color-rule)] bg-[var(--color-sunken)] p-3 font-mono text-[11px] text-[var(--color-faint)]">
              + {hidden} more, hidden on purpose — they don&rsquo;t change the
              outcome
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------- provenance */}
      <footer className="flex flex-col gap-2 border-t border-[var(--color-rule)] pt-5 font-mono text-[11px] leading-relaxed text-[var(--color-faint)]">
        <span>
          Scored against a snapshot taken{" "}
          {new Date(result.capturedAt).toLocaleString()} · fidelity:{" "}
          {result.fidelity}. Postings get pulled; this read does not.
        </span>
        <span>
          Models: {Object.entries(result.models).map(([k, v]) => `${k}=${v}`).join(" · ")}
        </span>
        {result.flags.length > 0 && (
          <span className="text-[var(--color-gap)]">
            {result.flags.length} claim(s) could not be traced to a source and
            are flagged rather than hidden.
          </span>
        )}
        <span>
          This read is saved in your browser on this device. It is not on our
          server, and closing the tab will not lose it — clearing your browser
          data will.
        </span>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onReset}
            className="self-start border border-[var(--color-rule)] px-3 py-1.5 uppercase tracking-wider text-[var(--color-ink)] hover:border-[var(--color-ink)]"
          >
            Start over
          </button>
          {onForget && (
            <button
              type="button"
              onClick={onForget}
              className="self-start border border-[var(--color-rule)] px-3 py-1.5 uppercase tracking-wider text-[var(--color-ink)] hover:border-[var(--color-block)] hover:text-[var(--color-block)]"
            >
              Delete everything on this device
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
