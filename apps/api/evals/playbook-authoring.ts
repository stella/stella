/**
 * Playbook authoring eval, contract tier: can a model drive `save_playbook`
 * from its schema and description alone, with no skill loaded?
 *
 * Each task plants one trap in the tool's grammar: the tier ladder, `extract`
 * versus `graded`, severity values, snake_case nesting, `source_id` to change a
 * position and its absence to add one, sending only what changed, and
 * recovering from the two refusals that name their own fix (a duplicate issue
 * and a stale `expected_updated_at`).
 *
 * The model is handed the production tool definitions and calls go through
 * `handleMcpToolCall`, so the schema parse, the lenient value readers, the
 * merge, and every error envelope are the ones an MCP client meets. Only the
 * rows are in memory (`lib/playbook-store.ts`). Run a small model beside a
 * large one: a large model works around a poor shape, a small one shows it.
 *
 *   bun run eval:playbook-authoring -- --models gpt-5.4-nano,gpt-5.6-luna --runs 3
 */

import { Value } from "@sinclair/typebox/value";
import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyServerTool, TokenUsage } from "@tanstack/ai";
import { panic } from "better-result";
import { writeFile } from "node:fs/promises";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  streamChatChunks,
  toolCallEndInputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { isRecord } from "@/api/lib/type-guards";
import { playbookPositionsSchema } from "@/api/lib/workflow/playbook-positions";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import { KNOWLEDGE_TOOL_DEFINITIONS } from "@/api/mcp/knowledge-tools";
import { handleMcpToolCall } from "@/api/mcp/tools";

import { runEvalModelTurn } from "./lib/model-turn";
import {
  PLAYBOOK_STEP_NAMES,
  scorePlaybookRun,
} from "./lib/playbook-authoring-score";
import type {
  PlaybookExpectation,
  PlaybookRunScore,
  PlaybookSteps,
  SaveCallRecord,
} from "./lib/playbook-authoring-score";
import { createPlaybookStore } from "./lib/playbook-store";
import type { PlaybookStore, StoredPlaybook } from "./lib/playbook-store";

// A bare id resolves through whichever configured provider rates it; Claude
// ids are pinned to Anthropic so another default provider cannot claim them.
const DEFAULT_MODELS = ["anthropic::claude-haiku-4-5-20251001", "gpt-5.6-luna"];
const DEFAULT_RUNS = 1;
// Every run is a paid request; keep a typo from turning into a bill.
const MAX_RUNS = 20;
const MAX_OUTPUT_TOKENS = 16_000;
const MAX_ITERATIONS = 8;
const MODEL_TURN_TIMEOUT_MS = 300_000;

const SAVE_PLAYBOOK = "save_playbook";
const LIST_PLAYBOOKS = "list_playbooks";
const TOOL_NAMES = [LIST_PLAYBOOKS, SAVE_PLAYBOOK] as const;

// No skill and no authoring guidance: the tool descriptions and schemas are
// the whole contract under test.
const SYSTEM_PROMPT = [
  "You maintain contract review playbooks for a law firm through the tools",
  "you are given. Do what the request asks with those tools, then reply with",
  "one short sentence. Do not ask questions; every fact you need is in the",
  "request or readable through the tools.",
].join(" ");

const SEEDED_PLAYBOOK_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const LIABILITY_ID = "11111111-1111-4111-8111-111111111111";
const GOVERNING_LAW_ID = "22222222-2222-4222-8222-222222222222";
const TERM_ID = "33333333-3333-4333-8333-333333333333";
const SEEDED_AT = new Date("2026-09-01T09:00:00.000Z");

const SEEDED_POSITIONS: Position[] = [
  {
    mode: "graded",
    sourceId: LIABILITY_ID,
    issue: "Liability cap",
    severity: "high",
    standard: {
      source: "tiers",
      tiers: {
        acceptable: {
          rules: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
              text: "Liability is capped at 12 months of fees",
            },
          ],
        },
        fallback: {
          entries: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
              text: "Liability is capped at 24 months of fees",
              label: "24-month cap",
            },
          ],
        },
        notAcceptable: {
          rules: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
              text: "Liability is uncapped",
            },
          ],
        },
      },
    },
    ask: { mode: "auto" },
    purpose: "Limits our exposure for claims under the agreement",
    enabled: true,
  },
  {
    mode: "graded",
    sourceId: GOVERNING_LAW_ID,
    issue: "Governing law",
    severity: "medium",
    standard: {
      source: "tiers",
      tiers: {
        acceptable: {
          rules: [
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
              text: "The agreement is governed by Czech law",
            },
          ],
        },
        fallback: { entries: [] },
        notAcceptable: { rules: [] },
      },
    },
    ask: { mode: "auto" },
    enabled: true,
  },
  {
    mode: "extract",
    sourceId: TERM_ID,
    issue: "Term",
    ask: {
      question: "How long is the initial term?",
      content: { version: 1, type: "text" },
    },
    enabled: true,
  },
];

const seededPlaybook = (): StoredPlaybook => ({
  id: SEEDED_PLAYBOOK_ID,
  name: "Supplier MSA",
  description: "Inbound supplier master services agreements",
  scope: { perspective: "buyer" },
  positions: { version: 3, items: structuredClone(SEEDED_POSITIONS) },
  status: "draft",
  approvedAt: null,
  createdAt: SEEDED_AT,
  updatedAt: SEEDED_AT,
});

type EvalTask = {
  id: string;
  /** Seeded rows; empty for the task that creates a playbook. */
  seed: readonly StoredPlaybook[];
  brief: string;
  /** Simulate a person saving in the editor just before the model's first
   *  update, so that update meets a stale-token conflict. */
  conflictBeforeFirstUpdate: boolean;
  expectation: PlaybookExpectation;
};

const gradedTiers = (positions: readonly Position[], issue: string) => {
  const position = positions.find(
    (candidate) => candidate.issue.trim().toLowerCase() === issue.toLowerCase(),
  );
  return position?.mode === "graded" && position.standard.source === "tiers"
    ? { position, tiers: position.standard.tiers }
    : null;
};

const hasRule = (rules: readonly { text: string }[], fragment: string) =>
  rules.some(({ text }) => text.toLowerCase().includes(fragment.toLowerCase()));

const EXISTING = `The playbook id is ${SEEDED_PLAYBOOK_ID}.`;

const TASKS: EvalTask[] = [
  {
    id: "create-ladder",
    seed: [],
    conflictBeforeFirstUpdate: false,
    brief: [
      'Create a playbook named "Inbound NDA" for reviewing NDAs we receive; we',
      "are the receiving party. It needs three positions:",
      '- "Confidentiality period", a walk-away term. Acceptable: the',
      "  obligations last at most 3 years. We can accept up to 5 years as a",
      "  fallback. Never acceptable: a perpetual obligation. Any deviation is",
      "  decided by the General Counsel.",
      '- "Residuals clause", low importance. Acceptable: the agreement has no',
      "  residuals clause.",
      '- "Effective date": no grading, just capture the date the agreement',
      "  takes effect.",
    ].join("\n"),
    expectation: {
      presentIssues: [
        "Confidentiality period",
        "Residuals clause",
        "Effective date",
      ],
      absentIssues: [],
      untouchedSourceIds: [],
      plantedRefusals: [],
      maxPositionsPerCall: 3,
      check: (positions) => {
        const defects: string[] = [];
        const period = gradedTiers(positions, "Confidentiality period");
        if (period === null) {
          defects.push("Confidentiality period is not a graded tiers position");
        } else {
          if (period.position.severity !== "blocker") {
            defects.push(
              `walk-away term saved as severity ${period.position.severity}`,
            );
          }
          if (!hasRule(period.tiers.acceptable.rules, "3")) {
            defects.push("acceptable tier lacks the 3-year rule");
          }
          if (!hasRule(period.tiers.fallback.entries, "5")) {
            defects.push("fallback tier lacks the 5-year alternative");
          }
          if (!hasRule(period.tiers.notAcceptable.rules, "perpetual")) {
            defects.push("not-acceptable tier lacks the perpetual red line");
          }
          if (
            !(period.position.negotiation?.escalation ?? "")
              .toLowerCase()
              .includes("general counsel")
          ) {
            defects.push(
              "the escalation route is not in negotiation.escalation",
            );
          }
        }
        const residuals = gradedTiers(positions, "Residuals clause");
        if (residuals?.position.severity !== "low") {
          defects.push(
            "Residuals clause is not a graded, low-severity position",
          );
        }
        const effective = positions.find(
          ({ issue }) => issue.trim().toLowerCase() === "effective date",
        );
        if (effective?.mode !== "extract") {
          defects.push("Effective date is not an extract position");
        } else if (effective.ask.content.type !== "date") {
          defects.push(
            `Effective date captures ${effective.ask.content.type}, not a date`,
          );
        }
        return defects;
      },
    },
  },
  {
    id: "add-one",
    seed: [seededPlaybook()],
    conflictBeforeFirstUpdate: false,
    brief: [
      EXISTING,
      'Add one position to it: "Payment terms", medium importance. Acceptable:',
      "payment is due no sooner than 60 days from invoice. Never acceptable:",
      "payment due in under 30 days. Leave everything else as it is.",
    ].join("\n"),
    expectation: {
      presentIssues: [
        "Liability cap",
        "Governing law",
        "Term",
        "Payment terms",
      ],
      absentIssues: [],
      untouchedSourceIds: [LIABILITY_ID, GOVERNING_LAW_ID, TERM_ID],
      plantedRefusals: [],
      maxPositionsPerCall: 1,
      check: (positions) =>
        gradedTiers(positions, "Payment terms")?.position.severity === "medium"
          ? []
          : ["Payment terms is not a graded, medium-severity position"],
    },
  },
  {
    id: "change-one",
    seed: [seededPlaybook()],
    conflictBeforeFirstUpdate: false,
    brief: [
      EXISTING,
      'Tighten its "Liability cap" position: liability above 36 months of fees',
      "is now also never acceptable. Keep the rest of that position, and every",
      "other position, exactly as it is.",
    ].join("\n"),
    expectation: {
      presentIssues: ["Liability cap", "Governing law", "Term"],
      absentIssues: [],
      untouchedSourceIds: [GOVERNING_LAW_ID, TERM_ID],
      plantedRefusals: [],
      maxPositionsPerCall: 1,
      check: (positions) => {
        const cap = gradedTiers(positions, "Liability cap");
        if (cap === null) {
          return ["Liability cap is no longer a graded tiers position"];
        }
        const defects: string[] = [];
        if (cap.position.sourceId !== LIABILITY_ID) {
          defects.push(
            "Liability cap was re-added instead of changed in place",
          );
        }
        if (!hasRule(cap.tiers.notAcceptable.rules, "36")) {
          defects.push("the 36-month red line is missing");
        }
        if (!hasRule(cap.tiers.notAcceptable.rules, "uncapped")) {
          defects.push("the stored uncapped red line was dropped");
        }
        if (
          !hasRule(cap.tiers.acceptable.rules, "12") ||
          !hasRule(cap.tiers.fallback.entries, "24")
        ) {
          defects.push("the stored acceptable or fallback tier was dropped");
        }
        if (cap.position.purpose === undefined) {
          defects.push("the stored purpose was dropped");
        }
        return defects;
      },
    },
  },
  {
    id: "duplicate-recovery",
    seed: [seededPlaybook()],
    conflictBeforeFirstUpdate: false,
    // Phrased as an addition although the position exists: the first save is
    // expected to meet the duplicate-issue refusal, and the task is whether the
    // refusal's hint is enough to land the change on the stored position.
    brief: [
      EXISTING,
      'Add a position "Governing law", medium importance. Acceptable: the',
      "agreement is governed by Czech law. Never acceptable: the agreement is",
      "governed by the law of a country outside the European Union.",
    ].join("\n"),
    expectation: {
      presentIssues: ["Liability cap", "Governing law", "Term"],
      absentIssues: [],
      untouchedSourceIds: [LIABILITY_ID, TERM_ID],
      plantedRefusals: ["validation_error"],
      maxPositionsPerCall: 1,
      check: (positions) => {
        const law = gradedTiers(positions, "Governing law");
        if (law === null) {
          return ["Governing law is no longer a graded tiers position"];
        }
        return [
          ...(law.position.sourceId === GOVERNING_LAW_ID
            ? []
            : ["the stored Governing law position was replaced by a new one"]),
          ...(hasRule(law.tiers.notAcceptable.rules, "european union")
            ? []
            : ["the new red line did not land"]),
        ];
      },
    },
  },
  {
    id: "conflict-recovery",
    seed: [seededPlaybook()],
    conflictBeforeFirstUpdate: true,
    brief: [
      EXISTING,
      'Add one position to it: "Audit rights", low importance. Acceptable: we',
      "may audit the supplier once a year on 30 days' notice. Leave everything",
      "else as it is.",
    ].join("\n"),
    expectation: {
      presentIssues: ["Liability cap", "Governing law", "Term", "Audit rights"],
      absentIssues: [],
      untouchedSourceIds: [LIABILITY_ID, GOVERNING_LAW_ID, TERM_ID],
      plantedRefusals: ["conflict"],
      maxPositionsPerCall: 1,
      check: () => [],
    },
  },
  {
    id: "remove-one",
    seed: [seededPlaybook()],
    conflictBeforeFirstUpdate: false,
    brief: [
      EXISTING,
      'Remove its "Term" position. Leave everything else as it is.',
    ].join("\n"),
    expectation: {
      presentIssues: ["Liability cap", "Governing law"],
      absentIssues: ["Term"],
      untouchedSourceIds: [LIABILITY_ID, GOVERNING_LAW_ID],
      plantedRefusals: [],
      maxPositionsPerCall: 0,
      check: () => [],
    },
  },
];

type ToolTrace = { name: string; input: unknown; result?: unknown };

const definitionOf = (name: (typeof TOOL_NAMES)[number]) =>
  KNOWLEDGE_TOOL_DEFINITIONS.find((definition) => definition.name === name) ??
  panic(`The knowledge tool set has no ${name}`);

/**
 * The tool as an MCP client is served it: the wire JSON Schema, and no
 * validation in the transport. Production validates inside the tool site, and
 * a transport that pre-validated would refuse calls the server answers with an
 * envelope, leaving nothing in the trace to score.
 */
const productionTool = (
  name: (typeof TOOL_NAMES)[number],
  handler: (input: unknown) => Promise<unknown>,
): AnyServerTool => {
  const definition = definitionOf(name);
  const schema = toTanStackToolSchema(definition.inputSchemaSource);
  const wireSchema = () => definition.inputSchema;
  return toolDefinition({
    name,
    description: definition.description,
    inputSchema: {
      ...schema,
      "~standard": {
        ...schema["~standard"],
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: wireSchema, output: wireSchema },
      },
    },
  }).server(handler);
};

const errorCodeOf = (payload: unknown): string | null => {
  const error = isRecord(payload) ? payload["error"] : undefined;
  if (!isRecord(error)) {
    return null;
  }
  return typeof error["code"] === "string" ? error["code"] : "error";
};

const createTools = ({
  store,
  task,
  trace,
  saveCalls,
}: {
  store: PlaybookStore;
  task: EvalTask;
  trace: ToolTrace[];
  saveCalls: SaveCallRecord[];
}): AnyServerTool[] => {
  let conflictPending = task.conflictBeforeFirstUpdate;

  const call = async (name: (typeof TOOL_NAMES)[number], input: unknown) => {
    const result = await handleMcpToolCall({
      args: isRecord(input) ? input : {},
      context: store.context,
      toolName: name,
    });
    const text = result.content.at(0);
    const payload: unknown =
      text?.type === "text" ? JSON.parse(text.text) : null;
    // The raw input is kept whether or not the call was accepted: a pass rate
    // without the payloads the tool refused cannot say which side failed.
    trace.push({ name, input, result: payload });
    return payload;
  };

  return [
    productionTool(
      LIST_PLAYBOOKS,
      async (input) => await call(LIST_PLAYBOOKS, input),
    ),
    productionTool(SAVE_PLAYBOOK, async (input) => {
      if (conflictPending && isRecord(input) && "playbook_id" in input) {
        conflictPending = false;
        store.touch(SEEDED_PLAYBOOK_ID);
      }
      const payload = await call(SAVE_PLAYBOOK, input);
      saveCalls.push({ input, refusal: errorCodeOf(payload) });
      return payload;
    }),
  ];
};

type ModelTurn = {
  error: string | null;
  finalText: string;
  latencyMs: number;
  usage: TokenUsage | null;
  rawCalls: ToolTrace[];
};

const runModelTurn = async ({
  model,
  prompt,
  tools,
}: {
  model: ResolvedTanStackTextModel;
  prompt: string;
  tools: AnyServerTool[];
}): Promise<ModelTurn> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    role: "fast",
    scopeKey: null,
  });
  const rawCalls: ToolTrace[] = [];
  const callNames = new Map<string, string>();
  let finalText = "";
  const { error, latencyMs, usage } = await runEvalModelTurn({
    timeoutMs: MODEL_TURN_TIMEOUT_MS,
    chat: (abortController) =>
      streamChatChunks({
        abortController,
        adapter: model.adapter,
        messages: [{ role: "user", content: prompt }],
        agentLoopStrategy: maxIterations(MAX_ITERATIONS),
        ...systemPromptsPatch({ caching, model, system: SYSTEM_PROMPT }),
        modelOptions: mergeGenerationOptions({
          caching,
          model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          serviceTier: "standard",
          temperature: 0,
        }),
        tools,
      }),
    onChunk: (chunk) => {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        finalText += chunk.delta;
        return;
      }
      if (chunk.type === EventType.TOOL_CALL_START) {
        const name = toolCallNameOf(chunk);
        if (name !== undefined) {
          callNames.set(chunk.toolCallId, name);
        }
        return;
      }
      if (chunk.type === EventType.TOOL_CALL_END) {
        rawCalls.push({
          name: toolCallNameOf(chunk) ?? callNames.get(chunk.toolCallId) ?? "",
          input: toolCallEndInputOf(chunk),
        });
      }
    },
  });
  return { error, finalText, latencyMs, usage, rawCalls };
};

type EvalRun = {
  model: string;
  task: string;
  run: number;
  score: PlaybookRunScore;
  /** Every tool call with its raw input and the envelope it was answered. */
  trace: ToolTrace[];
  finalText: string;
  latencyMs: number;
  tokens: number | null;
};

const RAW_CALL_SUFFIX = "(raw)";

const runTask = async ({
  model,
  modelId,
  repeat,
  task,
}: {
  model: ResolvedTanStackTextModel;
  modelId: string;
  repeat: number;
  task: EvalTask;
}): Promise<EvalRun> => {
  const store = createPlaybookStore(task.seed);
  const trace: ToolTrace[] = [];
  const saveCalls: SaveCallRecord[] = [];
  const turn = await runModelTurn({
    model,
    prompt: task.brief,
    tools: createTools({ store, task, trace, saveCalls }),
  });
  // A call the transport dropped before a handler ran still belongs in the
  // trace, under a name that says no handler saw it.
  for (const raw of turn.rawCalls.slice(trace.length)) {
    trace.push({ name: `${raw.name}${RAW_CALL_SUFFIX}`, input: raw.input });
  }

  const playbooks = store.playbooks();
  const [playbook] = playbooks;
  const finalPositions = playbook?.positions.items ?? null;
  const score = scorePlaybookRun({
    calls: saveCalls,
    expectation: task.expectation,
    finalPositions,
    seededPositions: task.seed.at(0)?.positions.items ?? [],
    turnError: turn.error,
  });
  // Every task ends on one playbook. With more, the positions may sit in a
  // row the score did not read, so its position defects prove nothing.
  if (playbooks.length > 1) {
    score.defects.push(
      `${playbooks.length} playbooks are stored; the task expects one`,
    );
    score.steps.saved = false;
    score.outcome = score.outcome === "pass" ? "partial" : score.outcome;
  }
  // What the tool stored must be what the HTTP route would have accepted.
  if (
    playbook !== undefined &&
    !Value.Check(playbookPositionsSchema, playbook.positions)
  ) {
    score.defects.push("the stored positions do not parse as positionSchema");
    score.steps.saved = false;
    score.outcome = score.outcome === "pass" ? "partial" : score.outcome;
  }
  return {
    model: modelId,
    task: task.id,
    run: repeat,
    score,
    trace,
    finalText: turn.finalText,
    latencyMs: turn.latencyMs,
    tokens: turn.usage?.totalTokens ?? null,
  };
};

type CliOptions = {
  models: string[];
  runs: number;
  taskFilter: string | null;
  jsonPath: string | null;
};

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    models: DEFAULT_MODELS,
    runs: DEFAULT_RUNS,
    taskFilter: null,
    jsonPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv.at(index);
    const value = argv.at(index + 1);
    if (flag === undefined || value === undefined) {
      continue;
    }
    switch (flag) {
      case "--models":
        options.models = value.split(",").map((id) => id.trim());
        index += 1;
        break;
      case "--runs":
        options.runs = Math.min(
          MAX_RUNS,
          Math.max(1, Number.parseInt(value, 10) || DEFAULT_RUNS),
        );
        index += 1;
        break;
      case "--task":
        options.taskFilter = value;
        index += 1;
        break;
      case "--json":
        options.jsonPath = value;
        index += 1;
        break;
      default:
        break;
    }
  }
  return options;
};

const cell = (values: readonly string[]): string =>
  values.length === 0
    ? "-"
    : values
        .join("; ")
        .replaceAll(/\r\n|\r|\n/gu, "<br>")
        .replaceAll("|", "\\|");

/** The four steps as initials, upper case when reached: `ASmu`. */
const stepsCell = (steps: PlaybookSteps): string =>
  PLAYBOOK_STEP_NAMES.map((name) => {
    const initial = name.slice(0, 1);
    return steps[name] ? initial.toUpperCase() : initial;
  }).join("");

const renderReport = (runs: readonly EvalRun[]): string => {
  const lines: string[] = ["# playbook-authoring (contract tier)"];
  for (const modelId of new Set(runs.map((run) => run.model))) {
    const modelRuns = runs.filter((run) => run.model === modelId);
    lines.push(
      `\n### ${modelId}\n`,
      "| task | run | outcome | steps | save calls | refusals | defects | tokens | ms |",
      "| --- | ---: | --- | --- | ---: | --- | --- | ---: | ---: |",
    );
    for (const run of modelRuns) {
      const saves = run.trace.filter(({ name }) => name === SAVE_PLAYBOOK);
      lines.push(
        `| ${run.task} | ${String(run.run)} | ${run.score.outcome} | ${stepsCell(run.score.steps)} | ${String(saves.length)} | ${cell(run.score.refusals)} | ${cell(run.score.defects)} | ${String(run.tokens ?? "-")} | ${String(run.latencyMs)} |`,
      );
    }
    const stepTotals = PLAYBOOK_STEP_NAMES.map(
      (name) =>
        `${name} ${String(modelRuns.filter((run) => run.score.steps[name]).length)}/${String(modelRuns.length)}`,
    ).join(", ");
    const passed = modelRuns.filter((run) => run.score.outcome === "pass");
    lines.push(
      "",
      `passed ${String(passed.length)}/${String(modelRuns.length)}, ${stepTotals}`,
    );
  }
  return lines.join("\n");
};

const resolveModels = async (modelIds: readonly string[]) => {
  const { getTanStackTextModelById, hasTanStackInstanceProvider } =
    await import("@/api/lib/tanstack-ai-models");
  if (!hasTanStackInstanceProvider()) {
    return panic(
      "No instance AI provider is configured; set a provider key in .env",
    );
  }
  return modelIds.map((id) => ({
    id,
    model: getTanStackTextModelById(id, null, {
      role: "fast",
      organizationId: null,
    }),
  }));
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const tasks = TASKS.filter(
    (task) => options.taskFilter === null || task.id === options.taskFilter,
  );
  if (tasks.length === 0) {
    panic(`No task is named ${String(options.taskFilter)}`);
  }

  const runs: EvalRun[] = [];
  for (const { id, model } of await resolveModels(options.models)) {
    for (const task of tasks) {
      for (let repeat = 1; repeat <= options.runs; repeat += 1) {
        process.stderr.write(`${id} · ${task.id} · run ${String(repeat)}\n`);
        runs.push(await runTask({ model, modelId: id, repeat, task }));
      }
    }
  }

  process.stdout.write(`${renderReport(runs)}\n`);
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify({ runs }, null, 2));
  }
};

await main();
// The tool registry import leaves a database handle open, which would keep
// the process alive after the report is written.
process.exit(0);
