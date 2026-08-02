/**
 * Token accounting.
 *
 * This exists because a provider key was drained during development and there
 * was no way to answer "on what?" after the fact. Usage was being returned by
 * every call and thrown away. Cost per read is a product question — it decides
 * whether this can be offered for free, rate-limited, or at all — so it is
 * measured rather than estimated.
 *
 * Deliberately in-memory and per-process: this is instrumentation, not billing.
 */

export type CallRecord = {
  stage: string;
  modelSpec: string;
  inputTokens: number;
  outputTokens: number;
  /** Retries are counted separately — they are pure waste and worth seeing. */
  isRetry: boolean;
};

/** Per-1M-token prices, input/output. Update when a provider's pricing moves. */
const PRICES: Record<string, { in: number; out: number }> = {
  "openai:gpt-5": { in: 1.25, out: 10 },
  "anthropic:claude-opus-4-8": { in: 5, out: 25 },
  "anthropic:claude-sonnet-5": { in: 3, out: 15 },
  "google:gemini-flash-latest": { in: 0.3, out: 2.5 },
};

export class UsageLedger {
  private calls: CallRecord[] = [];

  record(r: CallRecord) {
    this.calls.push(r);
  }

  get count() {
    return this.calls.length;
  }

  totals() {
    const input = this.calls.reduce((n, c) => n + c.inputTokens, 0);
    const output = this.calls.reduce((n, c) => n + c.outputTokens, 0);
    const retries = this.calls.filter((c) => c.isRetry);
    return {
      calls: this.calls.length,
      retries: retries.length,
      input,
      output,
      // Retried calls cost full price and produce nothing new. Tracking this
      // separately is what makes a validation-failure problem visible as a
      // COST problem rather than only a quality one.
      wastedInput: retries.reduce((n, c) => n + c.inputTokens, 0),
      wastedOutput: retries.reduce((n, c) => n + c.outputTokens, 0),
      cost: this.cost(this.calls),
      wastedCost: this.cost(retries),
    };
  }

  private cost(calls: CallRecord[]): number {
    return calls.reduce((sum, c) => {
      const p = PRICES[c.modelSpec];
      if (!p) return sum;
      return sum + (c.inputTokens / 1e6) * p.in + (c.outputTokens / 1e6) * p.out;
    }, 0);
  }

  byStage() {
    const map = new Map<
      string,
      { calls: number; input: number; output: number; cost: number }
    >();
    for (const c of this.calls) {
      const cur = map.get(c.stage) ?? { calls: 0, input: 0, output: 0, cost: 0 };
      cur.calls++;
      cur.input += c.inputTokens;
      cur.output += c.outputTokens;
      cur.cost += this.cost([c]);
      map.set(c.stage, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
  }

  report(label = "usage"): string {
    const t = this.totals();
    const lines = [
      `── ${label}`,
      `  calls        ${t.calls}${t.retries ? ` (${t.retries} were retries)` : ""}`,
      `  input        ${t.input.toLocaleString()} tokens`,
      `  output       ${t.output.toLocaleString()} tokens`,
      `  cost         $${t.cost.toFixed(4)}`,
    ];
    if (t.retries) {
      lines.push(
        `  wasted       $${t.wastedCost.toFixed(4)} on retries (${((t.wastedCost / t.cost) * 100).toFixed(0)}% of spend)`,
      );
    }
    lines.push("", "  by stage:");
    for (const [stage, s] of this.byStage()) {
      lines.push(
        `    ${stage.padEnd(18)} ${String(s.calls).padStart(3)} calls  ` +
          `${String(s.input).padStart(7)} in  ${String(s.output).padStart(6)} out  $${s.cost.toFixed(4)}`,
      );
    }
    return lines.join("\n");
  }
}

/** Process-wide ledger. One read per process in scripts; reset between runs. */
export const ledger = new UsageLedger();
