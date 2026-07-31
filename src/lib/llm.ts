import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateObject, type LanguageModel } from "ai";
import type { z } from "zod";

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

/** Sensible defaults per stage. Overridden by env; see resolveChain(). */
const STAGE_DEFAULTS: Record<Stage, string> = {
  extract_jd: "anthropic:claude-opus-4-8",
  extract_evidence: "anthropic:claude-opus-4-8",
  match: "anthropic:claude-opus-4-8",
  // Deliberately a different lab from `match`. If you point both at the same
  // model you still get an adversarial pass, but a much weaker one.
  adversary: "google:gemini-flash-latest",
  translate: "anthropic:claude-opus-4-8",
  quest: "anthropic:claude-opus-4-8",
  quiz: "anthropic:claude-opus-4-8",
};

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
    STAGE_DEFAULTS[stage];
  const specs = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!specs.length) {
    throw new Error(`No model configured for stage "${stage}".`);
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
function providerOptions(spec: string, stage: Stage) {
  const provider = spec.slice(0, spec.indexOf(":"));
  if (provider === "anthropic") {
    return {
      anthropic: {
        thinking: { type: "adaptive" as const },
        outputConfig: { effort: STAGE_EFFORT[stage] },
      },
    };
  }
  return undefined;
}

/** Whether a stage has credentials, so the UI only offers what will work. */
export function isConfigured(stage: Stage): boolean {
  const spec = resolveChain(stage)[0]!;
  const provider = spec.slice(0, spec.indexOf(":"));
  switch (provider) {
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "google":
      return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
    default:
      return false;
  }
}

/**
 * Errors where retrying with a DIFFERENT model is sensible: a hit quota or
 * rate limit, or the model being unavailable for this key. A genuine bad
 * request (bad schema or prompt) is not retried — it would fail on every model.
 */
function shouldFallback(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /quota|rate.?limit|429|resource.?exhausted|exhausted|not found|no longer available|404|unavailable|overloaded|529|permission|403/i.test(
    m,
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
}): Promise<GenerateResult<T>> {
  const specs = resolveChain(args.stage);
  let lastErr: unknown;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    try {
      const res = await generateObject({
        model: resolveModel(spec),
        schema: args.schema,
        system: args.system,
        prompt: args.prompt,
        providerOptions: providerOptions(spec, args.stage),
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
