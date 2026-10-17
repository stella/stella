/** Local harness handoff and deterministic scoring; never loads a provider. */
import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import { createShowVisualTools } from "../src/handlers/chat/tools/show-visual-tools";
import { createVisualResourceOrigin } from "../src/handlers/visual-sandbox/resource-origin";
import { generatedViewsCases } from "./lib/generated-views-cases";
import {
  generatedViewsLocalResultSchema,
  scoreGeneratedViews,
} from "./lib/generated-views-score";

const [mode, resultPath] = process.argv.slice(2);
if (mode === "prompts") {
  const tool = createShowVisualTools({
    origin: createVisualResourceOrigin(),
    store: () => panic("The selection harness does not publish views"),
    preview: () => panic("The selection harness does not request previews"),
  })[VISUAL_PREVIEW_TOOL_NAME];
  for (const scenario of generatedViewsCases) {
    console.log(
      JSON.stringify({
        caseId: scenario.id,
        prompt: scenario.prompt,
        tools: [
          {
            name: tool.name,
            description: tool.description,
            inputSchema: convertSchemaToJsonSchema(tool.inputSchema),
          },
        ],
        instruction:
          "Choose tools for this request. The supplied analysis or data is available in the conversation. Record your choice as JSON with caseId, harness (your local run label), answer, and toolCalls: [{name}]. Do not call any model provider API.",
      }),
    );
  }
} else if (mode === "score" && resultPath) {
  const results = readFileSync(resultPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => v.parse(generatedViewsLocalResultSchema, JSON.parse(line)));
  const scores = scoreGeneratedViews(results);
  for (const score of scores) {
    console.log(JSON.stringify(score));
  }
  process.exitCode = scores.every(
    ({ selectionPass, presentationPass }) => selectionPass && presentationPass,
  )
    ? 0
    : 1;
} else {
  panic(
    "Usage: bun evals/generated-views-local.ts prompts | score <local-results.jsonl>",
  );
}
