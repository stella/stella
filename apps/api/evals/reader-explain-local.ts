/** Local harness handoff and deterministic scoring; never loads a provider. */
import { panic } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { readerExplainCases } from "./lib/reader-explain-cases";
import {
  explainCorpusCaptureSchema,
  explainLocalResultSchema,
  explainToolTraceSchema,
  resolveExplainCase,
  scoreExplainCase,
} from "./lib/reader-explain-score";

const [mode, capturePath, resultOrCase, tracePath] = process.argv.slice(2);
if (
  (mode !== "prompts" && mode !== "score" && mode !== "tool") ||
  !capturePath ||
  ((mode === "score" || mode === "tool") && (!resultOrCase || !tracePath))
) {
  panic(
    "Usage: bun run evals/reader-explain-local.ts prompts <corpus-capture.json> | score <corpus-capture.json> <local-results.jsonl> <tool-trace.jsonl> | tool <corpus-capture.json> <case-id> <tool-trace.jsonl>",
  );
}
const corpus = v.parse(
  explainCorpusCaptureSchema,
  JSON.parse(readFileSync(capturePath, "utf-8")),
);
if (mode === "prompts") {
  for (const scenario of readerExplainCases) {
    const { selection, context } = resolveExplainCase(scenario, corpus);
    console.log(
      JSON.stringify({
        caseId: scenario.id,
        selection,
        decisionContext: context,
        tool: {
          name: "fetch_related_decision_excerpts",
          command: [
            "bun",
            "run",
            path.join(import.meta.dir, "reader-explain-local.ts"),
            "tool",
            path.resolve(capturePath),
            scenario.id,
            `${path.resolve(capturePath)}.tool-trace.jsonl`,
          ],
        },
        instruction: `${scenario.instruction} Explain the selection in this decision's context in English. If related case law helps, call fetch_related_decision_excerpts; execute its command with the local shell tool to replay bounded captured corpus excerpts. Cite by decisionId and paragraphId. Return JSON with caseId, harness (a nonempty local run label), answer, citations.`,
      }),
    );
  }
} else if (mode === "tool") {
  const scenario = readerExplainCases.find(({ id }) => id === resultOrCase);
  if (!scenario) {
    panic("Unknown Explain case");
  }
  const { excerpts } = resolveExplainCase(scenario, corpus);
  if (!tracePath) {
    panic("Missing local tool trace path");
  }
  appendFileSync(
    tracePath,
    `${JSON.stringify({ caseId: scenario.id, citations: excerpts.map(({ decisionId, paragraphId }) => ({ decisionId, paragraphId })) })}\n`,
  );
  console.log(JSON.stringify({ excerpts }));
} else {
  if (!resultOrCase || !tracePath) {
    panic("Missing local harness results or tool trace");
  }
  const traces = readFileSync(tracePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => v.parse(explainToolTraceSchema, JSON.parse(line)));
  const results = readFileSync(resultOrCase, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => v.parse(explainLocalResultSchema, JSON.parse(line)));
  const expectedIds = readerExplainCases.map(({ id }) => id).toSorted();
  const resultIds = results.map(({ caseId }) => caseId).toSorted();
  if (JSON.stringify(expectedIds) !== JSON.stringify(resultIds)) {
    panic("Results must cover each Explain case exactly once");
  }
  let failed = false;
  for (const scenario of readerExplainCases) {
    const result = results.find(({ caseId }) => caseId === scenario.id);
    if (!result) {
      panic(`Missing result for ${scenario.id}`);
    }
    const score = scoreExplainCase({
      scenario,
      corpus,
      result,
      toolReturnedCitations: traces
        .filter(({ caseId }) => caseId === scenario.id)
        .flatMap(({ citations }) => citations),
    });
    console.log(JSON.stringify(score));
    if (!score.citationPass) {
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
