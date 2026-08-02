/**
 * Show which model each stage would use, given the keys currently present.
 * No model is called — this only resolves configuration.
 *
 *   npm run check-routing
 */
import { providerStatus, resolveChain, type Stage } from "../src/lib/llm";

const STAGES: Stage[] = [
  "extract_jd",
  "extract_evidence",
  "match",
  "adversary",
  "translate",
  "quest",
  "quiz",
];

const status = providerStatus();

console.log("keys present :", status.available.join(", ") || "(none)");
console.log("primary      :", status.primary ?? "(none)");
console.log("adversary    :", status.adversary ?? "(none)");
console.log(
  "cross-lab    :",
  status.crossLab
    ? "yes — the adversarial pass runs on a different lab's model"
    : status.available.length === 1
      ? "NO — only one provider, so it degrades to self-critique"
      : "n/a — no provider configured",
);
console.log();

for (const stage of STAGES) {
  try {
    console.log(`  ${stage.padEnd(18)} ${resolveChain(stage).join(" -> ")}`);
  } catch (err) {
    console.log(
      `  ${stage.padEnd(18)} ERROR: ${err instanceof Error ? err.message : err}`,
    );
  }
}
