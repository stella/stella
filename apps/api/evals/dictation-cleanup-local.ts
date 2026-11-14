/** Local harness handoff and deterministic scoring; never loads a provider. */
import { toJsonSchema } from "@valibot/to-json-schema";
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  buildDictationCleanupPrompt,
  DICTATION_CLEANUP_SYSTEM_PROMPT,
  dictationCleanupModelOutputSchema,
} from "../src/handlers/dictation/cleanup-model";
import { dictationCleanupCases } from "./lib/dictation-cleanup-cases";
import {
  dictationCleanupLocalResultSchema,
  scoreDictationCleanup,
} from "./lib/dictation-cleanup-score";

const [mode, resultPath] = process.argv.slice(2);
if (mode === "prompts") {
  const outputSchema = toJsonSchema(dictationCleanupModelOutputSchema);
  for (const scenario of dictationCleanupCases) {
    console.log(
      JSON.stringify({
        caseId: scenario.id,
        system: DICTATION_CLEANUP_SYSTEM_PROMPT,
        prompt: buildDictationCleanupPrompt({
          transcript: scenario.transcript,
          locale: scenario.locale,
          languages: [scenario.locale],
        }),
        outputSchema,
        instruction:
          "Answer the prompt under the system text with one JSON object matching outputSchema. Record it as JSON with caseId, harness (your local run label) and output. Do not call any model provider API.",
      }),
    );
  }
} else if (mode === "score" && resultPath) {
  const results = readFileSync(resultPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) =>
      v.parse(dictationCleanupLocalResultSchema, JSON.parse(line)),
    );
  const scores = scoreDictationCleanup(results);
  for (const score of scores) {
    console.log(JSON.stringify(score));
  }
  process.exitCode = scores.every(({ pass }) => pass) ? 0 : 1;
} else {
  panic(
    "Usage: bun evals/dictation-cleanup-local.ts prompts | score <local-results.jsonl>",
  );
}
