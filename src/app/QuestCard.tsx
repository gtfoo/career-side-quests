"use client";

import { useState } from "react";
import type { ProjectBrief } from "@/lib/schema";

/**
 * One side quest.
 *
 * Two deliberate choices:
 *
 *  - The cut line is drawn IN the milestone list, not described next to it. The
 *    reader's real question is "when can I stop?", and a dashed line through
 *    the list answers it faster than a sentence about scope ever will.
 *
 *  - The resume bullets and talk track are hidden until the shippable
 *    milestones are ticked. It is light gamification, but honest: you cannot
 *    claim the thing until you have built it. It is also the only mechanic here
 *    that brings someone back a week later.
 */
export function QuestCard({
  brief,
  done,
  onToggle,
}: {
  brief: ProjectBrief;
  done: Set<string>;
  onToggle: (milestoneId: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);

  const gates = brief.milestones.filter((m) => m.beforeCutLine);
  const gatesDone = gates.filter((m) => done.has(m.id)).length;
  const unlocked = gates.length > 0 && gatesDone === gates.length;
  const showRewards = unlocked || revealed;

  const cutIndex = brief.milestones.findIndex((m) => !m.beforeCutLine);

  return (
    <section className="border border-[var(--color-ink)] bg-[var(--color-surface)]">
      <header className="flex flex-col gap-2.5 border-b border-[var(--color-rule)] p-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-faint)]">
          Side quest · closes {brief.proves.map((p) => p.requirementId).join(", ")}
        </span>
        <h3 className="text-balance font-serif text-2xl font-semibold leading-tight">
          {brief.title}
        </h3>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-[var(--color-muted)]">
          <span>~{brief.timeBudget.totalHours} hours</span>
          <span>·</span>
          <span>{brief.timeBudget.sessions} sessions</span>
          <span>·</span>
          <span>{brief.proofArtifacts.join(" · ")}</span>
        </div>
      </header>

      <div className="flex flex-col gap-6 p-6">
        <div>
          <h4 className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-faint)]">
            What it moves
          </h4>
          <div className="flex flex-col gap-1.5">
            {brief.proves.map((p) => (
              <div
                key={p.requirementId}
                className="grid grid-cols-[42px_1fr_auto] items-baseline gap-3 text-sm"
              >
                <span className="font-mono text-[11px] text-[var(--color-faint)]">
                  {p.requirementId}
                </span>
                <q className="text-[var(--color-muted)]">{p.jdQuote}</q>
                <span className="whitespace-nowrap font-mono text-[11px] tabular-nums">
                  {p.from}/3 <span className="text-[var(--color-carry)]">→ {p.to}/3</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {brief.youAlreadyHave.length > 0 && (
          <div>
            <h4 className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-faint)]">
              You already have
            </h4>
            <ul className="flex flex-col gap-2">
              {brief.youAlreadyHave.map((y, i) => (
                <li key={i} className="border-l-2 border-[var(--color-carry)] pl-3">
                  <span className="text-sm">{y.what}</span>
                  <q className="mt-0.5 block text-[13px] text-[var(--color-muted)]">
                    {y.evidenceQuote}
                  </q>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h4 className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-faint)]">
            New ground &mdash; only {brief.theStretch.length}
          </h4>
          <ul className="flex flex-col gap-1.5">
            {brief.theStretch.map((s, i) => (
              <li key={i} className="relative pl-4 text-sm before:absolute before:left-0 before:top-[9px] before:h-px before:w-2 before:bg-[var(--color-muted)]">
                {s}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-faint)]">
            Build it
          </h4>
          <div className="flex flex-col">
            {brief.milestones.map((m, i) => (
              <div key={m.id}>
                {i === cutIndex && cutIndex > 0 && (
                  <div className="flex items-center gap-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-carry)]">
                    Ship here &mdash; the rest is optional
                    <span className="h-px flex-1 border-t border-dashed border-[var(--color-carry)] opacity-50" />
                  </div>
                )}
                <label className="grid cursor-pointer grid-cols-[20px_1fr_46px] items-start gap-3 border-b border-[var(--color-rule)]/60 py-3">
                  <input
                    type="checkbox"
                    checked={done.has(m.id)}
                    onChange={() => onToggle(m.id)}
                    className="mt-[3px] h-[15px] w-[15px] accent-[var(--color-carry)]"
                  />
                  <span>
                    <span
                      className={`text-sm ${done.has(m.id) ? "text-[var(--color-muted)] line-through decoration-[var(--color-rule)]" : ""}`}
                    >
                      {m.title}
                    </span>
                    <span className="mt-1 block font-mono text-[12px] text-[var(--color-muted)]">
                      {m.acceptance.map((a) => `✓ ${a}`).join("   ")}
                    </span>
                  </span>
                  <span className="pt-0.5 text-right font-mono text-xs tabular-nums text-[var(--color-faint)]">
                    {m.hours}h
                  </span>
                </label>
              </div>
            ))}
          </div>
        </div>

        {/* Locked until the shippable set is done. */}
        <div
          className={`flex flex-col gap-3 border p-5 transition-colors ${
            showRewards
              ? "border-[var(--color-carry)] bg-[var(--color-surface)]"
              : "border-[var(--color-rule)] bg-[var(--color-sunken)]"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              className={`font-mono text-[10px] uppercase tracking-[0.12em] ${showRewards ? "text-[var(--color-carry)]" : "text-[var(--color-faint)]"}`}
            >
              {showRewards ? "Unlocked" : "Locked"} &mdash; CV lines and your answer
              to &ldquo;tell me about it&rdquo;
            </span>
            <span className="font-mono text-[10px] tabular-nums text-[var(--color-faint)]">
              {gatesDone} / {gates.length} shipped
            </span>
          </div>

          <div
            className={
              showRewards
                ? "flex flex-col gap-3.5"
                : // print-hide: blur is a screen effect. On paper it prints as a
                  // grey smear that reads as a rendering fault, so the print
                  // stylesheet drops this block and leaves the "Locked" label.
                  "print-hide pointer-events-none select-none blur-[4.5px] opacity-50"
            }
            aria-hidden={!showRewards}
          >
            {brief.resumeBullets.map((b, i) => (
              <p
                key={i}
                className="border-l-2 border-[var(--color-carry)] pl-3.5 text-sm"
              >
                {/* Placeholders stay visible: the number is theirs to fill in,
                    and the app must never guess it. */}
                {b.split(/(\{\{[^}]*\}\})/).map((part, j) =>
                  part.startsWith("{{") ? (
                    <mark
                      key={j}
                      className="bg-[var(--color-gap)]/15 px-1 font-mono text-[12.5px] text-[var(--color-gap)]"
                    >
                      {part}
                    </mark>
                  ) : (
                    part
                  ),
                )}
              </p>
            ))}
            <div>
              <h4 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-faint)]">
                When they ask about it
              </h4>
              <p className="text-sm">{brief.talkTrack.pitch}</p>
              <ul className="mt-2 flex flex-col gap-1">
                {brief.talkTrack.likelyFollowUps.map((q, i) => (
                  <li key={i} className="text-[13px] text-[var(--color-muted)]">
                    &ldquo;{q}&rdquo;
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {!showRewards && (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="self-start font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)] underline underline-offset-2 hover:text-[var(--color-ink)]"
            >
              Show anyway
            </button>
          )}
        </div>

        <div className="border-l-[3px] border-[var(--color-gap)] bg-[var(--color-gap)]/8 p-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-gap)]">
            What it won&rsquo;t prove
          </span>
          <p className="mt-1 text-sm">{brief.honestLimits}</p>
        </div>
      </div>
    </section>
  );
}
