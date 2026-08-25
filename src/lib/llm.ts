import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { generateObject, type LanguageModel } from "ai";
import type { z } from "zod";
import { assertSpendAllowed } from "./spend";
import { ledger } from "./usage";
import { recordUsage } from "./report";

/**
 * The single place a model is chosen, built on the Vercel AI SDK so swapping
 * labs is a config change rather than a code change.
 *
 * Stages are named because they want different things: extraction wants cheap
 * and literal, judgement wants the strongest model available, and the
 * adversarial pass wants a model from a DIFFERENT LAB than the one that
 * produced the scores — same-model self-critique shares the same blind spots,
 * and every model is flattering about resumes in the same direction.
 *
 * Per-stage override, most specific first:
 *
 *   MODEL_MATCH=anthropic:claude-opus-4-8
 *   MODEL_ADVERSARY=google:gemini-flash-latest
 *   MODEL_DEFAULT=anthropic:claude-opus-4-8
 *
 * A comma-separated list is a fallback CHAIN, tried in order — when the first
 * is rate-limited or unavailable, the next runs. Order them best-first.
 */

export type Stage =
  | "extract_jd"
  | "extract_evidence"
  | "match"
  | "adversary"
  | "translate"
  | "quest"
  | "quiz";

/**
 * Provider preference, most-preferred first. The first one with a key becomes
 * the primary; the next distinct one becomes the adversary.
 */
const PROVIDER_ORDER = ["openai", "anthropic", "google"] as const;

const ENV_KEY: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

/** Which providers actually have credentials right now, in preference order. */
function availableProviders(): string[] {
  return PROVIDER_ORDER.filter((p) => Boolean(process.env[ENV_KEY[p]!]));
}

/** The model we reach for first on each provider, for judgement-heavy work. */
const PREFERRED: Record<string, string> = {
  openai: "openai:gpt-5",
  anthropic: "anthropic:claude-opus-4-8",
  google: "google:gemini-flash-latest",
};

/**
 * Defaults adapt to the keys present, so the app runs with one provider and
 * gets better with two. Explicit env always wins — see resolveChain().
 *
 * The adversarial stage deliberately picks a DIFFERENT provider from the
 * scoring stage when one is available. With a single key it falls back to the
 * same model, which still helps but is a weaker check: a model reviewing its
 * own reasoning shares its own blind spots.
 */
function stageDefault(stage: Stage): string {
  const available = availableProviders();
  if (!available.length) {
    // Named so the error says what to do, rather than failing on a missing key
    // somewhere deep in a provider SDK.
    throw new Error(
      "No model provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY or " +
        "GOOGLE_GENERATIVE_AI_API_KEY in .env.local (see .env.example).",
    );
  }
  // A stage that sees the user's CV may only use providers that do not train
  // on input. This filter comes FIRST, before any cost or quality preference,
  // and applies to fallbacks too: running out of paid credit is not a reason to
  // send someone's resume somewhere it can be trained on and read by humans.
  // Better to fail the read and say why.
  const eligible = STAGE_SEES_USER_DATA[stage]
    ? available.filter((p) => !mayTrainOnInput(p))
    : available;

  if (!eligible.length) {
    throw new Error(
      `No provider available for "${stage}" that is safe for personal data. ` +
        `Every configured provider reserves the right to train on input. ` +
        `Add an OpenAI or Anthropic key, or set GOOGLE_PAID_TIER=true if that ` +
        `key is on Google's paid tier (the free tier trains on submissions and ` +
        `allows human review).`,
    );
  }

  const primary = eligible[0]!;

  // Mechanical stages run cheapest-first. Their output is checked against the
  // source verbatim, so a weaker model costs a retry rather than credibility —
  // and these are the stages a free tier can actually absorb.
  if (STAGE_TIER[stage] === "mechanical") {
    const cheap: string[] = CHEAPEST_FIRST.filter((p) => eligible.includes(p));
    // Stronger models still follow, so a free tier running out of quota
    // degrades to a paid one instead of ending the read.
    const rest = eligible.filter((p) => !cheap.includes(p));
    return [...cheap, ...rest].map((p) => PREFERRED[p]!).join(",");
  }

  // Every stage gets the other providers appended as a fallback chain. A key
  // that is out of credit or rate-limited should degrade to the next lab, not
  // end the run: an exhausted primary otherwise takes down a read that two
  // other configured providers could have finished. This is not hypothetical —
  // it happened mid-development, and the failure looked like a clean pass
  // because nothing ran at all.
  const chain =
    stage === "adversary"
      ? [
          ...eligible.filter((p) => p !== primary),
          primary, // last resort: self-critique beats no critique
        ]
      : eligible;

  return chain.map((p) => PREFERRED[p]!).join(",");
}

/**
 * Which stages can safely run on the cheapest available model.
 *
 * "mechanical" does not mean easy — it means WRONG ANSWERS GET CAUGHT. Both
 * extraction stages must quote their sources verbatim, and every quote is
 * checked as a literal substring before it is accepted (pipeline/validate.ts).
 * A weaker model that invents a quote is rejected and asked again, so its
 * failure mode is a retry rather than a false claim reaching the user.
 *
 * "judgement" stages have no such backstop. `match` decides a LEVEL, and no
 * string check can tell a generous 3 from an honest 2 — so it stays on the
 * strongest model configured and only the eval set may argue otherwise.
 *
 * Rate limits agree with this split: free tiers run around 15 requests/minute,
 * which comfortably covers two sequential extraction calls per read and would
 * be swamped instantly by the parallel per-requirement fan-out.
 */
const STAGE_TIER: Record<Stage, "mechanical" | "judgement"> = {
  extract_jd: "mechanical",
  extract_evidence: "mechanical",
  quiz: "mechanical",
  match: "judgement",
  adversary: "judgement",
  translate: "judgement",
  quest: "judgement",
};

/** Cheapest first. Used only for mechanical stages. */
const CHEAPEST_FIRST = ["google", "openai", "anthropic"] as const;

/**
 * Which stages are shown the CANDIDATE'S OWN material.
 *
 * This is a privacy boundary, not a performance one. The job description is a
 * public posting; a CV is not. Anything true here must never reach a provider
 * whose terms permit training on input — see mayTrainOnInput().
 */
const STAGE_SEES_USER_DATA: Record<Stage, boolean> = {
  extract_jd: false, // the posting only — public text
  extract_evidence: true, // the CV itself
  match: true, // quotes lifted from the CV
  adversary: true,
  translate: true,
  quest: true,
  quiz: true,
};

/**
 * Does this provider reserve the right to train on what we send it?
 *
 * Google's free tier does, explicitly: "Google uses the content you submit to
 * the Services and any generated responses to provide, improve, and develop
 * Google products", and "human reviewers may read, annotate, and process your
 * API input and output". The PAID tier does not. Nothing in the API response
 * reveals which tier a key is on, so the safe assumption is free — set
 * GOOGLE_PAID_TIER=true to declare otherwise.
 *
 * OpenAI and Anthropic both state they do not train on API data by default.
 */
function mayTrainOnInput(provider: string): boolean {
  if (provider !== "google") return false;
  return process.env.GOOGLE_PAID_TIER !== "true";
}

/** Effort/thinking is provider-specific, so it lives with the model choice. */
const STAGE_EFFORT: Record<Stage, "low" | "medium" | "high" | "xhigh"> = {
  extract_jd: "low",
  extract_evidence: "medium",
  match: "medium",
  adversary: "medium",
  translate: "high",
  quest: "xhigh",
  quiz: "medium",
};

function envKey(stage: Stage): string {
  return `MODEL_${stage.toUpperCase()}`;
}

/** "provider:model-id" -> a LanguageModel. */
function resolveModel(spec: string): LanguageModel {
  const idx = spec.indexOf(":");
  if (idx === -1) {
    throw new Error(
      `Model spec "${spec}" must be "provider:model-id", e.g. "anthropic:claude-opus-4-8".`,
    );
  }
  const provider = spec.slice(0, idx).trim();
  const id = spec.slice(idx + 1).trim();

  switch (provider) {
    case "anthropic":
      return anthropic(id);
    case "openai":
      return openai(id);
    case "google":
      return google(id);
    default:
      throw new Error(
        `Unknown provider "${provider}" in "${spec}". Add a case in src/lib/llm.ts.`,
      );
  }
}

/** The ordered list of specs to try for a stage, most-preferred first. */
export function resolveChain(stage: Stage): string[] {
  const raw =
    process.env[envKey(stage)] ??
    process.env.MODEL_DEFAULT ??
    stageDefault(stage);
  const specs = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!specs.length) {
    throw new Error(`No model configured for stage "${stage}".`);
  }

  // An explicit env override must not be able to route personal data somewhere
  // it can be trained on. Someone setting MODEL_MATCH by hand is choosing a
  // model, not waiving the user's privacy — and the user is not the one setting
  // the variable. Drop offenders rather than honouring them.
  if (STAGE_SEES_USER_DATA[stage]) {
    const safe = specs.filter(
      (s) => !mayTrainOnInput(s.slice(0, s.indexOf(":"))),
    );
    if (safe.length !== specs.length) {
      console.warn(
        `[${stage}] dropped ${specs.length - safe.length} model(s) that may train on input. ` +
          `This stage handles the candidate's own CV.`,
      );
    }
    if (!safe.length) {
      throw new Error(
        `Every model configured for "${stage}" may train on its input, and this ` +
          `stage handles personal data. Set GOOGLE_PAID_TIER=true if that key is ` +
          `on the paid tier, or configure an OpenAI/Anthropic model.`,
      );
    }
    return safe;
  }

  return specs;
}

/**
 * Provider-specific knobs the AI SDK passes straight through. Kept in one place
 * because this is exactly what a lowest-common-denominator abstraction would
 * flatten away, and these are the settings that decide output quality.
 *
 * On Anthropic: thinking must be requested EXPLICITLY — omitting the field runs
 * without it. `budget_tokens` and temperature/top_p/top_k are rejected outright
 * on current models; effort is the only depth dial.
 */
function providerOptions(
  spec: string,
  stage: Stage,
): ProviderOptions | undefined {
  const provider = spec.slice(0, spec.indexOf(":"));
  const effort = STAGE_EFFORT[stage];

  if (provider === "anthropic") {
    return {
      anthropic: {
        thinking: { type: "adaptive" as const },
        outputConfig: { effort },
      },
    };
  }

  if (provider === "openai") {
    // The reasoning models take low/medium/high only — there is no "xhigh", so
    // the top tier clamps rather than erroring on the stages that ask for it.
    return {
      openai: {
        reasoningEffort: effort === "xhigh" ? "high" : effort,
      },
    };
  }

  // Gemini deliberately gets no provider options. Thinking is billed from the
  // same output allowance as the answer, which truncated a 40-atom extraction
  // into invalid JSON (2,260 tokens reasoning, 270 emitting) — but this model
  // rejects `thinkingConfig.thinkingBudget: 0` outright, so thinking cannot be
  // turned off. The fix is a large enough output ceiling for both; see
  // maxOutputTokens().
  return undefined;
}

/**
 * Extraction returns one object containing every requirement or evidence atom,
 * so its output is long by nature. The default ceilings are tuned for chat and
 * truncate it — which surfaces as a schema error, not as "ran out of room".
 */
function maxOutputTokens(stage: Stage): number {
  // Reasoning is billed from the SAME allowance as the answer, so the ceiling
  // has to cover BOTH — and the highest-effort stage needs the most room for
  // each. Observed on a real run: the quest stage at xhigh effort spent 7,040
  // tokens reasoning against an 8,000 ceiling, leaving 960 for a large object,
  // which truncated into a schema error. The symptom is never "ran out of
  // room"; it is always "response did not match schema".
  // Batch matching puts every requirement in one response, so the ceiling must
  // cover a whole read's worth of judgements plus the reasoning behind them.
  // Sized generously on purpose: the first thing a squeezed budget drops is
  // counter-evidence, and losing that makes scores generous without anything
  // visibly failing.
  if (stage === "match" && process.env.MATCH_STRATEGY === "batch") return 32000;

  switch (STAGE_EFFORT[stage]) {
    case "xhigh":
      return 32000;
    case "high":
      return 16000;
    default:
      return STAGE_TIER[stage] === "mechanical" ? 16000 : 12000;
  }
}

/** Whether a stage has credentials, so the UI only offers what will work. */
export function isConfigured(stage: Stage): boolean {
  const spec = resolveChain(stage)[0]!;
  const provider = spec.slice(0, spec.indexOf(":"));
  const key = ENV_KEY[provider];
  return Boolean(key && process.env[key]);
}

/** What is actually wired up right now — surfaced in the UI and in evals. */
export function providerStatus(): {
  available: string[];
  primary: string | null;
  adversary: string | null;
  crossLab: boolean;
} {
  const available = availableProviders();
  const primary = available[0] ?? null;
  const adversary = available.find((p) => p !== primary) ?? primary;
  return {
    available,
    primary,
    adversary,
    // The adversarial pass is only worth much when it runs on a different lab's
    // model — one key means it degrades to self-critique.
    crossLab: Boolean(primary && adversary && primary !== adversary),
  };
}

/**
 * Errors where retrying with a DIFFERENT model is sensible: a hit quota or
 * rate limit, or the model being unavailable for this key. A genuine bad
 * request (bad schema or prompt) is not retried — it would fail on every model.
 */
/**
 * Flatten an error into searchable text.
 *
 * The AI SDK wraps a failed call in AI_RetryError whose own message says only
 * that retries were exhausted; the reason lives further down, in the cause
 * chain and in the provider's raw responseBody. Reading just `.message` misses
 * it — which is how an out-of-credit key killed a run that two other
 * configured providers could have finished.
 */
function errorText(err: unknown, depth = 0): string {
  if (depth > 4 || err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return String(err);

  const e = err as Record<string, unknown>;
  return [
    typeof e.message === "string" ? e.message : "",
    typeof e.responseBody === "string" ? e.responseBody : "",
    typeof e.code === "string" ? e.code : "",
    typeof e.type === "string" ? e.type : "",
    errorText(e.cause, depth + 1),
    errorText(e.lastError, depth + 1),
    ...(Array.isArray(e.errors) ? e.errors.map((x) => errorText(x, depth + 1)) : []),
  ].join(" ");
}

function shouldFallback(err: unknown): boolean {
  return /quota|rate.?limit|429|resource.?exhausted|exhausted|insufficient|no credits|credit_balance|billing|not found|no longer available|404|unavailable|overloaded|529|permission|403/i.test(
    errorText(err),
  );
}

export type GenerateResult<T> = {
  object: T;
  /** Which spec actually produced this. Recorded so evals stay honest. */
  modelSpec: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/**
 * generateObject with automatic fallback down the stage's model chain.
 * Returns the first success along with the model that produced it.
 */
export async function generate<T>(args: {
  stage: Stage;
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  /** Set when this call is re-running after failed validation, so the ledger
   *  can separate useful spend from waste. */
  isRetry?: boolean;
}): Promise<GenerateResult<T>> {
  // Before resolving anything, before touching a provider SDK. This is the one
  // chokepoint every paid call passes through, so the check belongs here rather
  // than in each caller — a new stage cannot forget it.
  assertSpendAllowed(args.stage);

  const specs = resolveChain(args.stage);
  let lastErr: unknown;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const startedAt = Date.now();
    try {
      const res = await generateObject({
        model: resolveModel(spec),
        schema: args.schema,
        system: args.system,
        prompt: args.prompt,
        maxOutputTokens: maxOutputTokens(args.stage),
        providerOptions: providerOptions(spec, args.stage),
      });
      // Record before returning, so no successful call can escape accounting.
      const u = res.usage as
        | {
            reasoningTokens?: number;
            cachedInputTokens?: number;
            cacheCreationInputTokens?: number;
          }
        | undefined;
      ledger.record({
        stage: args.stage,
        modelSpec: spec,
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
        reasoningTokens: u?.reasoningTokens ?? 0,
        cachedInputTokens: u?.cachedInputTokens ?? 0,
        isRetry: args.isRetry ?? false,
        ms: Date.now() - startedAt,
      });
      // The same event, to the box-level dashboard. Separate from the ledger
      // above because they answer different questions: the ledger is one
      // process's report at the end of a run, this is a durable cross-app
      // record of what was spent and when.
      recordUsage({
        provider: spec.split(":")[0]!,
        model: spec.split(":").slice(1).join(":"),
        op: args.stage,
        in_tokens: res.usage?.inputTokens ?? 0,
        out_tokens: res.usage?.outputTokens ?? 0,
        // `?? null`, never `?? 0`. A provider that does not report cache usage
        // has told us nothing, and zero would assert that the call read
        // nothing from cache — a measurement nobody took.
        in_cache_read: u?.cachedInputTokens ?? null,
        in_cache_write: u?.cacheCreationInputTokens ?? null,
        status: "ok",
      });

      return {
        object: res.object as T,
        modelSpec: spec,
        usage: {
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
        },
      };
    } catch (err) {
      lastErr = err;
      // Failures are recorded, not just successes. On a free tier a 429 is the
      // only trustworthy evidence of where the ceiling actually sits, because
      // the documented limits move without notice — and a fallback that fires
      // constantly is invisible from a success-only log.
      //
      // Narrower than shouldFallback() on purpose: that deliberately conflates
      // quota, billing, 404s and overload because for FALLBACK they all mean
      // "try the next model". Here they are different facts and flattening
      // them would make a billing failure read as a rate limit.
      recordUsage({
        provider: spec.split(":")[0]!,
        model: spec.split(":").slice(1).join(":"),
        op: args.stage,
        in_tokens: null,
        out_tokens: null,
        status: /quota|rate.?limit|429|resource.?exhausted|overloaded|529/i.test(
          errorText(err),
        )
          ? "rate_limited"
          : "error",
      });
      const hasNext = i < specs.length - 1;
      if (hasNext && shouldFallback(err)) {
        console.warn(
          `[${args.stage}] model "${spec}" unavailable (${
            err instanceof Error ? err.message : String(err)
          }); falling back to "${specs[i + 1]}".`,
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
