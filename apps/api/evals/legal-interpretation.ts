/** Synthetic behavior eval; no legal conclusion is scored. Paid model calls are opt-in. */
import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type * as v from "valibot";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { resolveCaching } from "@/api/lib/ai-config";
import type {
  READ_CASE_LAW_DECISION_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
} from "@/api/lib/chat/projections";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";
import {
  mergeGenerationOptions,
  resolveTanStackTextModel,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import { STELLA_TOOL_DEFINITIONS } from "@/api/mcp/stella-tools";

import {
  FIXTURE_DECISION_ID,
  FIXTURE_IDENTIFIERS,
  INTERPRETATION_SCENARIOS,
  scoreInterpretation,
} from "./lib/legal-interpretation-score";
import type { InterpretationCall } from "./lib/legal-interpretation-score";
import { runEvalModelTurn } from "./lib/model-turn";

const options = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    models: { type: "string" },
    task: { type: "string" },
    json: { type: "string" },
    help: { type: "boolean" },
  },
}).values;
if (options.help || !options.models) {
  process.stdout.write(
    "Usage: bun --env-file=.env evals/legal-interpretation.ts --models provider::modelId[,modelId] [--task case-id] [--json /tmp/results.json]\nExplicit --models is required: this eval calls paid providers.\n",
  );
  process.exit(options.help ? 0 : 1);
}
const scenarios = INTERPRETATION_SCENARIOS.filter(
  (scenario) => !options.task || scenario.id === options.task,
);
if (scenarios.length === 0) {
  panic(`Unknown scenario: ${String(options.task)}`);
}
const skillRoot = path.resolve(
  import.meta.dir,
  "../../../packages/skills/skills/legal-interpretation",
);
const resources = ["SKILL.md"];
for await (const file of new Bun.Glob("references/**/*.md").scan(skillRoot)) {
  resources.push(file);
}
resources.sort();
const system = (
  await Promise.all(
    resources.map(
      async (file) =>
        `Resource ${file}:\n${await readFile(path.join(skillRoot, file), "utf-8")}`,
    ),
  )
).join("\n\n");
const records = [];
for (const modelId of options.models.split(",")) {
  if (!modelId.trim()) {
    panic("Model IDs must be nonempty");
  }
  const model = await resolveTanStackTextModel({
    modelId,
    orgAIConfig: null,
    dataClass: "customer",
    managedAIResidency: "eu",
    role: "fast",
    organizationId: null,
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
  });
  process.stdout.write(
    `\n### ${modelId}\n\n| case | outcome | defects | ms |\n| --- | --- | --- | ---: |\n`,
  );
  for (const scenario of scenarios) {
    const calls: InterpretationCall[] = [];
    const hasCaseLaw = !["no-case-law", "missing-overlay"].includes(
      scenario.id,
    );
    const tools = ["search_case_law", "read_case_law_decision"].map((name) => {
      const definition =
        STELLA_TOOL_DEFINITIONS.find((entry) => entry.name === name) ??
        panic(`Missing production tool ${name}`);
      const schema = toTanStackToolSchema(definition.inputSchemaSource);
      // Keep raw rejected inputs in the eval trace, as the MCP transport does.
      return toolDefinition({
        name,
        description: definition.description,
        inputSchema: {
          ...schema,
          "~standard": {
            ...schema["~standard"],
            validate: (value: unknown) => ({ value }),
            jsonSchema: {
              input: () => definition.inputSchema,
              output: () => definition.inputSchema,
            },
          },
        },
      }).server(async (input: unknown) => {
        const parsed = await schema["~standard"].validate(input);
        const accepted = !parsed.issues;
        const discovered =
          accepted && name === "search_case_law" && hasCaseLaw
            ? [...FIXTURE_IDENTIFIERS]
            : [];
        const read =
          accepted &&
          name === "read_case_law_decision" &&
          hasCaseLaw &&
          typeof input === "object" &&
          input !== null &&
          "decision_ids" in input &&
          Array.isArray(input.decision_ids) &&
          input.decision_ids.includes(FIXTURE_DECISION_ID)
            ? [...FIXTURE_IDENTIFIERS]
            : [];
        calls.push({
          name,
          input,
          accepted: accepted && (name === "search_case_law" || read.length > 0),
          discovered,
          read,
        });
        if (!accepted) {
          return {
            code: "validation_error",
            issues: parsed.issues,
            message: "Correct the input using the tool schema.",
          };
        }
        if (name === "search_case_law") {
          return {
            headnotes: "omitted",
            facets: null,
            nextCursor: null,
            searches: [],
            total: { type: "exact", count: hasCaseLaw ? 1 : 0 },
            results: hasCaseLaw
              ? [
                  {
                    decisionId: FIXTURE_DECISION_ID,
                    caseNumber: FIXTURE_IDENTIFIERS[1],
                    ecli: FIXTURE_IDENTIFIERS[0],
                    court: "Synthetic test court",
                    courtAbbreviation: null,
                    country: "cze",
                    decisionDate: "2026-02-01",
                    snippet:
                      "This synthetic decision discusses vehicles in section 3. Read its text before relying on it.",
                    appUrl: null,
                    url: null,
                    citationCount: 0,
                    citationAuthority: 0,
                    resourceName: FIXTURE_DECISION_ID,
                    decisionType: null,
                    language: "en",
                    matchedQueries: [0],
                    matchingPassages: 1,
                    sourceUrl: null,
                    keywords: null,
                    headnote: null,
                  },
                ]
              : [],
          } satisfies v.InferOutput<typeof SEARCH_CASE_LAW_PROJECTION>;
        }
        return {
          items: read.length
            ? [
                {
                  decisionId: FIXTURE_DECISION_ID,
                  status: "found",
                  decision: {
                    decisionId: FIXTURE_DECISION_ID,
                    caseNumber: FIXTURE_IDENTIFIERS[1],
                    ecli: FIXTURE_IDENTIFIERS[0],
                    text: "Synthetic evaluation decision: the court distinguishes ordinary wording from the purpose of section 3. The legislative record is incomplete and both readings require analysis. This fixture states no binding rule.",
                  },
                },
              ]
            : [
                {
                  decisionId: FIXTURE_DECISION_ID,
                  status: "not_found",
                  message: "No readable decision found. Search first.",
                },
              ],
        } satisfies v.InferOutput<typeof READ_CASE_LAW_DECISION_PROJECTION>;
      });
    });
    let text = "";
    const caching = resolveCaching({
      promptCachingEnabled: false,
      role: "fast",
      scopeKey: null,
    });
    const turn = await runEvalModelTurn({
      timeoutMs: 120_000,
      chat: (abortController) =>
        streamChatChunks({
          abortController,
          adapter: model.adapter,
          messages: [{ role: "user", content: scenario.request }],
          tools,
          agentLoopStrategy: maxIterations(12),
          ...systemPromptsPatch({ caching, model, system }),
          modelOptions: mergeGenerationOptions({
            caching,
            model,
            maxOutputTokens: 6000,
            serviceTier: "standard",
            temperature: 0,
          }),
        }),
      onChunk: (chunk) => {
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
          text += chunk.delta;
        }
      },
    });
    const defects = scoreInterpretation({
      scenario,
      text,
      calls,
      overlayAvailable: resources.includes(
        `references/jurisdictions/${scenario.jurisdiction}.md`,
      ),
    });
    if (turn.error) {
      defects.unshift(turn.error);
    }
    records.push({
      model: modelId,
      scenario: scenario.id,
      ...turn,
      text,
      calls,
      defects,
    });
    process.stdout.write(
      `| ${scenario.id} | ${defects.length ? "fail" : "pass"} | ${defects.join("; ").replaceAll("|", "/").replaceAll("\n", " ")} | ${String(turn.latencyMs)} |\n`,
    );
  }
}
process.stdout.write(
  `\n${String(records.filter((record) => record.defects.length === 0).length)}/${String(records.length)} passed.\n`,
);
if (options.json) {
  await writeFile(options.json, JSON.stringify(records, null, 2));
}
if (records.some((record) => record.defects.length)) {
  process.exitCode = 1;
}
