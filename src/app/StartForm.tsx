"use client";

import { useEffect, useRef, useState } from "react";
import * as local from "@/lib/store/local";
import { ReadScreen, type ReadResult } from "./ReadScreen";

/**
 * The input screen: what you're aiming at, and what you've got.
 *
 * Two decisions here are product decisions, not layout ones:
 *
 *  - The target options are a FIDELITY LADDER. A read built from a live posting
 *    and one built from a job title are not the same claim, so the user is told
 *    which they are getting before the work runs, not apologised to afterwards.
 *  - Parse coverage is surfaced the moment a file lands. A silent partial parse
 *    is the worst failure this app can have.
 */

type TargetMode = "posting" | "pasted" | "company_role" | "market_role";

type Snapshot = {
  title: string | null;
  locations: string[];
  fidelity: string;
  text: string;
  capturedAt: string;
};

type ParsedDoc = {
  filename: string;
  pages: number;
  coverage: number;
  needsVision: number[];
  chars: number;
  notice: string | null;
  text: string;
};

const TARGET_OPTIONS: {
  mode: TargetMode;
  label: string;
  hint: string;
  sharpness: string;
  strong: boolean;
}[] = [
  {
    mode: "posting",
    label: "A specific job posting",
    hint: "Link to the live posting",
    sharpness: "Sharpest",
    strong: true,
  },
  {
    mode: "pasted",
    label: "Paste the job description",
    hint: "For postings behind a login",
    sharpness: "Sharp",
    strong: true,
  },
  {
    mode: "company_role",
    label: "A role at a company",
    hint: "Built from their open postings",
    sharpness: "Rough",
    strong: false,
  },
  {
    mode: "market_role",
    label: "Just a role, anywhere",
    hint: "Built from the market",
    sharpness: "Roughest",
    strong: false,
  },
];

/**
 * Only GitHub is actually fetched. The others are recorded as notes so they
 * reach the read, but nothing pretends to have visited them — claiming to have
 * read a portfolio we never opened would be exactly the kind of unearned
 * confidence this app is built to avoid.
 */
const LINK_FIELDS = [
  { key: "portfolio", label: "Portfolio", placeholder: "yoursite.com" },
  {
    key: "linkedin",
    label: "LinkedIn",
    placeholder: "Save your profile as PDF and upload it above",
  },
  { key: "other", label: "Anything else", placeholder: "A talk, a paper, a product" },
] as const;

export function StartForm() {
  const [mode, setMode] = useState<TargetMode>("posting");
  const [url, setUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [roleText, setRoleText] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [targetMsg, setTargetMsg] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [docs, setDocs] = useState<ParsedDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [links, setLinks] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  const [gh, setGh] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghErr, setGhErr] = useState<string | null>(null);

  async function readGithub() {
    if (!gh.trim()) return;
    setGhBusy(true);
    setGhErr(null);
    try {
      const res = await fetch("/api/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: gh }),
      });
      const data = await res.json();
      if (data.ok) {
        // Replace rather than append, so reading the same profile twice does
        // not double-count it as evidence.
        setDocs((d) => [...d.filter((x) => x.filename !== data.doc.filename), data.doc]);
        setGh("");
      } else {
        setGhErr(data.message);
      }
    } catch {
      setGhErr("Could not reach GitHub. Try again.");
    } finally {
      setGhBusy(false);
    }
  }

  const [reading, setReading] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [result, setResult] = useState<ReadResult | null>(null);

  const [restored, setRestored] = useState(false);
  const [canStore, setCanStore] = useState(true);

  // Dev-only: `?preview=1` renders the read screen from a fixture, so layout
  // changes can be checked without spending a model call on every tweak.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!new URLSearchParams(window.location.search).has("preview")) return;
    void fetch("/stub-read.json")
      .then((r) => r.json())
      .then(setResult)
      .catch(() => {});
  }, []);

  // Restore whatever was in progress. Runs once, before the user can type, so
  // a refresh part-way through a read is recoverable rather than fatal.
  useEffect(() => {
    setCanStore(local.isAvailable());
    const saved = local.load();
    if (!saved) return;
    if (saved.mode) setMode(saved.mode as TargetMode);
    if (saved.url) setUrl(saved.url);
    if (saved.pasted) setPasted(saved.pasted);
    if (saved.roleText) setRoleText(saved.roleText);
    if (saved.snapshot) setSnapshot(saved.snapshot);
    if (saved.docs?.length) setDocs(saved.docs);
    if (saved.links) setLinks(saved.links);
    if (saved.notes) setNotes(saved.notes);
    if (saved.result) setResult(saved.result as ReadResult);
    setRestored(true);
  }, []);

  // Persist on every meaningful change. This is a few KB of JSON; the
  // alternative is losing an upload to a stray refresh.
  useEffect(() => {
    local.save({ mode, url, pasted, roleText, snapshot, docs, links, notes });
  }, [mode, url, pasted, roleText, snapshot, docs, links, notes]);

  useEffect(() => {
    if (result) local.save({ result });
  }, [result]);

  /** Wipe everything held on this device. */
  function forget() {
    local.clear();
    setMode("posting");
    setUrl("");
    setPasted("");
    setRoleText("");
    setSnapshot(null);
    setTargetMsg(null);
    setDocs([]);
    setLinks({});
    setNotes("");
    setResult(null);
    setRestored(false);
  }

  async function runRead() {
    if (!snapshot || !docs.length) return;
    setReading(true);
    setReadErr(null);
    try {
      // Links the user typed are evidence too, but they are not fetched yet —
      // pass them as notes so they at least reach the read rather than being
      // silently dropped.
      const linkNotes = Object.entries(links)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");

      const res = await fetch("/api/assess", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          snapshot,
          docs: docs.map((d) => ({ id: d.filename, text: d.text })),
          notes: [notes, linkNotes].filter(Boolean).join("\n\n"),
        }),
      });
      const data = await res.json();
      if (data.ok) setResult(data.result);
      else setReadErr(data.message);
    } catch {
      setReadErr("The read failed to complete. Try again.");
    } finally {
      setReading(false);
    }
  }

  if (result) {
    return (
      <ReadScreen
        result={result}
        onReset={() => {
          setResult(null);
          local.save({ result: undefined });
        }}
        onForget={forget}
      />
    );
  }

  async function resolveTarget() {
    setChecking(true);
    setTargetMsg(null);
    setSnapshot(null);
    try {
      const res = await fetch("/api/target", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "posting" ? { url } : { text: pasted || roleText },
        ),
      });
      const data = await res.json();
      if (data.ok) setSnapshot(data.snapshot);
      else setTargetMsg(data.message);
    } catch {
      setTargetMsg("Could not reach the server. Try again.");
    } finally {
      setChecking(false);
    }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setUploadErr(null);
    for (const file of Array.from(files)) {
      const body = new FormData();
      body.append("file", file);
      try {
        const res = await fetch("/api/evidence", { method: "POST", body });
        const data = await res.json();
        if (data.ok) setDocs((d) => [...d, data.doc]);
        else setUploadErr(data.message);
      } catch {
        setUploadErr("Upload failed. Try again.");
      }
    }
    setUploading(false);
  }

  const ready = Boolean(snapshot) && docs.length > 0;

  return (
    <div className="flex flex-col gap-8">
      {restored && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-2.5">
          <span className="text-sm">
            Picked up where you left off &mdash; this was saved on this device.
          </span>
          <button
            type="button"
            onClick={forget}
            className="border border-[var(--color-rule)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider hover:border-[var(--color-block)] hover:text-[var(--color-block)]"
          >
            Clear it
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 items-start gap-5">
        {/* ------------------------------------------------ where you're headed */}
        <section className="flex flex-col gap-5 border border-[var(--color-rule)] bg-[var(--color-surface)] p-6">
          <header className="flex flex-col gap-1">
            <h2 className="font-serif text-xl font-semibold">
              Where you&rsquo;re headed
            </h2>
            <p className="text-sm text-[var(--color-muted)]">
              The more specific you are, the less I have to guess.
            </p>
          </header>

          <div className="flex flex-col gap-2">
            {TARGET_OPTIONS.map((opt) => (
              <label
                key={opt.mode}
                className={`grid cursor-pointer grid-cols-[16px_1fr_auto] items-center gap-3 border p-3 transition-colors ${
                  mode === opt.mode
                    ? "border-[var(--color-carry)] bg-[var(--color-carry)]/8"
                    : "border-[var(--color-rule)] hover:border-[var(--color-muted)]"
                }`}
              >
                <input
                  type="radio"
                  name="target"
                  checked={mode === opt.mode}
                  onChange={() => {
                    setMode(opt.mode);
                    setSnapshot(null);
                    setTargetMsg(null);
                  }}
                  className="h-3.5 w-3.5 accent-[var(--color-carry)]"
                />
                <span className="text-sm">
                  {opt.label}
                  <small className="mt-0.5 block text-xs text-[var(--color-muted)]">
                    {opt.hint}
                  </small>
                </span>
                <span
                  className={`whitespace-nowrap border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                    opt.strong
                      ? "border-[var(--color-carry)] text-[var(--color-carry)]"
                      : "border-[var(--color-rule)] text-[var(--color-muted)]"
                  }`}
                >
                  {opt.sharpness}
                </span>
              </label>
            ))}
          </div>

          {mode === "posting" ? (
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://jobs.ashbyhq.com/… or a Greenhouse / Lever link"
              className="border border-[var(--color-rule)] bg-[var(--color-sunken)] px-3 py-2.5 font-mono text-xs outline-none focus:border-[var(--color-carry)]"
            />
          ) : mode === "pasted" ? (
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={5}
              placeholder="Paste the full job description here."
              className="resize-y border border-[var(--color-rule)] bg-[var(--color-sunken)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-carry)]"
            />
          ) : (
            <input
              type="text"
              value={roleText}
              onChange={(e) => setRoleText(e.target.value)}
              placeholder={
                mode === "company_role"
                  ? "e.g. Solutions Engineer at ElevenLabs"
                  : "e.g. Solutions Engineer at an AI company"
              }
              className="border border-[var(--color-rule)] bg-[var(--color-sunken)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-carry)]"
            />
          )}

          <button
            type="button"
            onClick={resolveTarget}
            disabled={checking}
            className="self-start border border-[var(--color-rule)] px-4 py-2 font-mono text-[11px] uppercase tracking-wider hover:border-[var(--color-ink)] disabled:opacity-50"
          >
            {checking ? "Looking…" : "Find it"}
          </button>

          {snapshot && (
            <div className="flex flex-col gap-1 border border-[var(--color-carry)] bg-[var(--color-carry)]/8 p-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-carry)]">
                Found it
              </span>
              <span className="text-sm">
                {snapshot.title ?? "Job description captured"}
              </span>
              <span className="font-mono text-[11px] text-[var(--color-faint)]">
                {snapshot.locations.join(" · ") || "no locations listed"} ·{" "}
                {snapshot.text.length} chars · snapshot taken{" "}
                {new Date(snapshot.capturedAt).toLocaleDateString()}
              </span>
            </div>
          )}

          {targetMsg && (
            <div className="flex flex-col gap-2 border-l-2 border-[var(--color-gap)] bg-[var(--color-gap)]/8 p-3">
              <p className="text-sm">{targetMsg}</p>
              {mode !== "pasted" && (
                <button
                  type="button"
                  onClick={() => {
                    setMode("pasted");
                    setTargetMsg(null);
                  }}
                  className="self-start font-mono text-[11px] uppercase tracking-wider text-[var(--color-carry)] underline"
                >
                  Paste it instead →
                </button>
              )}
            </div>
          )}
        </section>

        {/* -------------------------------------------------- what you've got */}
        <section className="flex flex-col gap-5 border border-[var(--color-rule)] bg-[var(--color-surface)] p-6">
          <header className="flex flex-col gap-1">
            <h2 className="font-serif text-xl font-semibold">
              What you&rsquo;ve got
            </h2>
            <p className="text-sm text-[var(--color-muted)]">
              Anything that shows evidence. A CV alone is fine to start.
            </p>
          </header>

          {/*
            Stated BEFORE a file can be chosen, not in a policy page nobody
            opens. The absences are the part worth reading, so they are listed
            explicitly rather than implied by silence.
          */}
          <div className="flex flex-col gap-1.5 border-l-2 border-[var(--color-carry)] bg-[var(--color-carry)]/8 p-3">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--color-carry)]">
              Before you upload
            </span>
            <p className="text-[13px] leading-relaxed">
              {canStore ? (
                <>
                  Your CV is read in your browser and kept{" "}
                  <strong>on this device only</strong>
                  {" — "}not on our server. Clearing your browser data
                  removes it.
                </>
              ) : (
                <>
                  Your browser is blocking local storage, so nothing can be
                  saved here &mdash; your CV is used for this read only and
                  disappears when you close the tab.
                </>
              )}
            </p>
            {/*
              "Not used for training" is a claim about someone ELSE'S terms, so
              it is framed as our reading of them and linked, rather than
              asserted flatly. Terms change; a user who can click through can
              check for themselves and does not have to take our word for it.
              The restriction is also enforced in code — providers whose terms
              permit training on input are excluded from every stage that sees a
              CV (src/lib/llm.ts).
            */}
            <p className="text-[13px] leading-relaxed text-[var(--color-muted)]">
              To score it, the text goes to OpenAI or Anthropic. As we read
              their terms today, neither uses API input to train their models by
              default &mdash; check for yourself:{" "}
              <a
                href="https://developers.openai.com/api/docs/guides/your-data"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-ink)]"
              >
                OpenAI
              </a>
              ,{" "}
              <a
                href="https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-ink)]"
              >
                Anthropic
              </a>
              . Providers whose terms allow training on input are blocked from
              seeing your CV in code, not just by intention. The job posting
              &mdash; public text &mdash; may go elsewhere, including{" "}
              <a
                href="https://ai.google.dev/gemini-api/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-ink)]"
              >
                Google
              </a>
              .
            </p>

            {/*
              Deliberately separate, and visually distinct: this is advice that
              holds regardless of what any provider's terms say, and it is the
              part that protects the user beyond this app. Terms can change,
              companies get breached, and a CV is a document people paste into
              a dozen sites without thinking.
            */}
            <p className="border-t border-[var(--color-carry)]/25 pt-2 text-[13px] leading-relaxed text-[var(--color-muted)]">
              Worth saying anyway: treat anything you upload anywhere on the
              internet as <strong>potentially public</strong>, and share only
              what you&rsquo;d be comfortable with if it were. In particular,
              keep your employer&rsquo;s confidential details &mdash; client
              names under NDA, unreleased products, internal figures &mdash; off
              your CV entirely. Not just here. Anywhere.
            </p>
          </div>

          {docs.map((doc) => (
            <div
              key={doc.filename}
              className={`grid grid-cols-[1fr_auto] items-center gap-3 border p-3 ${
                doc.needsVision.length
                  ? "border-[var(--color-gap)] bg-[var(--color-gap)]/8"
                  : "border-[var(--color-rule)]"
              }`}
            >
              <span className="text-sm">
                {doc.filename}
                <small className="mt-0.5 block font-mono text-[11px] text-[var(--color-faint)]">
                  {doc.notice ??
                    `${doc.pages} page(s) read · ${doc.chars} chars`}
                </small>
              </span>
              <span
                className={`whitespace-nowrap border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                  doc.needsVision.length
                    ? "border-[var(--color-gap)] text-[var(--color-gap)]"
                    : "border-[var(--color-carry)] text-[var(--color-carry)]"
                }`}
              >
                {doc.needsVision.length
                  ? `${Math.round(doc.coverage * 100)}% read`
                  : "Read"}
              </span>
            </div>
          ))}

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(e.dataTransfer.files);
            }}
            onClick={() => fileInput.current?.click()}
            className={`flex cursor-pointer flex-col items-center gap-1 border border-dashed p-6 text-center transition-colors ${
              dragging
                ? "border-[var(--color-carry)] bg-[var(--color-carry)]/8"
                : "border-[var(--color-rule)] hover:border-[var(--color-muted)]"
            }`}
          >
            <span className="text-sm">
              {uploading ? "Reading…" : "Drop your CV here, or browse"}
            </span>
            <small className="text-xs text-[var(--color-muted)]">
              PDF or DOCX. LinkedIn: profile → Save to PDF, then drop it here.
            </small>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx,.txt,.md"
              multiple
              hidden
              onChange={(e) => void upload(e.target.files)}
            />
          </div>

          {uploadErr && (
            <p className="border-l-2 border-[var(--color-block)] bg-[var(--color-block)]/8 p-3 text-sm">
              {uploadErr}
            </p>
          )}

          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-faint)]">
              GitHub · optional, and read properly
            </span>
            <div className="flex gap-2">
              <input
                type="text"
                value={gh}
                onChange={(e) => setGh(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void readGithub();
                }}
                placeholder="github.com/you"
                className="flex-1 border border-[var(--color-rule)] bg-[var(--color-sunken)] px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--color-carry)]"
              />
              <button
                type="button"
                onClick={readGithub}
                disabled={ghBusy || !gh.trim()}
                className="border border-[var(--color-rule)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider hover:border-[var(--color-ink)] disabled:opacity-40"
              >
                {ghBusy ? "Reading…" : "Read"}
              </button>
            </div>
            <p className="text-[11px] text-[var(--color-muted)]">
              Actually fetched: languages, sizes, recency. This is what turns a
              claimed skill into a shown one — or shows it isn&rsquo;t there.
            </p>
            {ghErr && (
              <p className="border-l-2 border-[var(--color-gap)] bg-[var(--color-gap)]/8 p-2 text-[13px]">
                {ghErr}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-faint)]">
              Other links · recorded, not visited
            </span>
            {LINK_FIELDS.map((f) => (
              <label key={f.key} className="grid grid-cols-[90px_1fr] items-center gap-2">
                <span className="font-mono text-[11px] text-[var(--color-muted)]">
                  {f.label}
                </span>
                <input
                  type="text"
                  value={links[f.key] ?? ""}
                  onChange={(e) =>
                    setLinks((l) => ({ ...l, [f.key]: e.target.value }))
                  }
                  placeholder={f.placeholder}
                  className="border border-[var(--color-rule)] bg-[var(--color-sunken)] px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--color-carry)]"
                />
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-faint)]">
              What have you done that isn&rsquo;t on your CV?
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Side projects, things you shipped, work from a previous field. People delete their old life from a CV right when it matters most."
              className="resize-y border border-[var(--color-rule)] bg-[var(--color-sunken)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-carry)]"
            />
          </div>
        </section>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={runRead}
            disabled={!ready || reading}
            className="border border-[var(--color-ink)] bg-[var(--color-ink)] px-6 py-3 font-mono text-xs uppercase tracking-wider text-[var(--color-paper)] hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {reading ? "Reading…" : "Read my position"}
          </button>
          <small className="font-mono text-[11px] text-[var(--color-faint)]">
            {reading
              ? "Scoring each requirement separately — this takes a minute"
              : ready
                ? "About a minute · nothing is kept after the read"
                : "Add a target and at least one document to continue"}
          </small>
        </div>

        {readErr && (
          <p className="border-l-2 border-[var(--color-block)] bg-[var(--color-block)]/8 p-3 text-sm">
            {readErr}
          </p>
        )}
      </div>
    </div>
  );
}
