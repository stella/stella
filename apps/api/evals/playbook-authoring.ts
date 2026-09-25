/**
 * Playbook authoring eval, in two tiers.
 *
 * Contract tier: can a model drive `save_playbook` from its schema and
 * description alone, with no skill loaded?
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
 * Behavior tier: does a model with the shipped `playbook-builder` skill
 * active build a playbook the way the skill says? The skill reaches the
 * prompt through the production active-skill path, `ask-user` is the
 * production definition answered from a script (so the interview runs inside
 * one agent loop), a scenario's follow-up messages are later turns over the
 * conversation so far, and the matter reads are answered from fixtures
 * (`lib/playbook-builder-scenarios.ts`) on each of two surfaces: as direct
 * MCP tools, and as the chat surface, where the fixtures sit behind the
 * production registry runner under the real `execute_typescript` and
 * `discover_tools` tools and the sandbox, and `spawn_subagents` is offered
 * under chat's delegation instruction, so a run meets the same eager and
 * lazy catalog, error envelopes, refs, and temptations a chat does.
 *
 *   bun run eval:playbook-authoring -- --models gpt-5.4-nano,gpt-5.6-luna --runs 3
 *   bun run eval:playbook-authoring -- --tier behavior --task discovery --surface chat
 */

import { Value } from "@sinclair/typebox/value";
import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyServerTool, ModelMessage, TokenUsage } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { writeFile } from "node:fs/promises";

import { DEFAULT_MODELS } from "@stll/ai-catalog";

import { resolveActiveChatSkillContext } from "@/api/handlers/chat/active-skill-context";
import type { ActiveChatSkillContext } from "@/api/handlers/chat/active-skill-context";
import {
  buildActiveSkillSection,
  SUBAGENT_DELEGATION_SECTION,
} from "@/api/handlers/chat/chat-prompt";
import { areSubagentToolsRegistered } from "@/api/handlers/chat/tools/chat-tools";
import {
  chatCodeModeSystemPrompt,
  createChatCodeModeSurface,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import type { ChatCodeModeReadRunner } from "@/api/handlers/chat/tools/execute/chat-code-mode";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { createOrgTools } from "@/api/handlers/chat/tools/org-tools";
import { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { SPAWN_SUBAGENTS_TOOL_DEFINITION } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/subagent-tool-shared";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  LIST_TEMPLATES_TOOL_DEFINITION,
  LIST_TEMPLATES_TOOL_NAME,
} from "@/api/handlers/chat/tools/template-tools";
import { resolveCaching } from "@/api/lib/ai-config";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import {
  streamChatChunks,
  toolCallEndInputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { isRecord } from "@/api/lib/type-guards";
import { playbookPositionsSchema } from "@/api/lib/workflow/playbook-positions";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import { DOCUMENT_TOOL_DEFINITIONS } from "@/api/mcp/document-tools";
import { KNOWLEDGE_TOOL_DEFINITIONS } from "@/api/mcp/knowledge-tools";
import { getStaticMcpToolHandler } from "@/api/mcp/static-tool-definitions";
import { STELLA_TOOL_DEFINITIONS } from "@/api/mcp/stella-tools";
import { TEMPLATE_TOOL_SET } from "@/api/mcp/template-tools";
import type { McpToolHandler } from "@/api/mcp/tool-types";
import { serializeToolResult } from "@/api/mcp/tool-utils";
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
import {
  BUILDER_SCENARIOS,
  BUILDER_SURFACES,
  DISCOVER_TOOLS,
  EXECUTE_TYPESCRIPT,
  MATTER_TOOL_NAMES,
  SAVE_PLAYBOOK,
  answerMatterTool,
  isMatterToolName,
  scoreScenario,
} from "./lib/playbook-builder-scenarios";
import type {
  AskedQuestion,
  BuilderEvent,
  BuilderScenario,
  BuilderSurface,
  MatterToolName,
} from "./lib/playbook-builder-scenarios";
import { findUnchangedResends } from "./lib/playbook-builder-score";
import { createPlaybookStore } from "./lib/playbook-store";
import type { PlaybookStore, StoredPlaybook } from "./lib/playbook-store";

// A bare id resolves through whichever configured provider rates it; Claude
// ids are pinned to Anthropic so another default provider cannot claim them.
// The instance default chat model is the one a chat without an organization
// override runs, so the chat surface is measured on it; gpt-5.4-mini is the
// smallest OpenAI model chats run in the field, and the one the skill text
// was first seen to lose.
const DEFAULT_EVAL_MODELS = [
  "anthropic::claude-haiku-4-5-20251001",
  "gpt-5.4-mini",
  "gpt-5.6-luna",
  DEFAULT_MODELS.openai.chat,
];
const DEFAULT_RUNS = 1;
// Every run is a paid request; keep a typo from turning into a bill.
const MAX_RUNS = 20;
const MAX_OUTPUT_TOKENS = 16_000;
const MAX_ITERATIONS = 8;
const MODEL_TURN_TIMEOUT_MS = 300_000;
// A behavior run interviews, reads contracts, and saves position by position
// inside one agent loop.
const BEHAVIOR_MAX_ITERATIONS = 40;
const BEHAVIOR_TURN_TIMEOUT_MS = 900_000;
const PLAYBOOK_BUILDER_SKILL = "playbook-builder";
// Sandbox admission key for the chat surface; runs are sequential.
const EVAL_SANDBOX_KEY = "playbook-authoring-eval";

const TIERS = ["contract", "behavior"] as const;
type Tier = (typeof TIERS)[number];

const LIST_PLAYBOOKS = "list_playbooks";
const TOOL_NAMES = [LIST_PLAYBOOKS, SAVE_PLAYBOOK] as const;

// No skill and no authoring guidance: the tool descriptions and schemas are
// the whole contract under test.
const CONTRACT_SYSTEM_PROMPT = [
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

/** The seeded playbook's side; a task that edits it must leave it stored. */
const SEEDED_PERSPECTIVE = "buyer";

const seededPlaybook = (): StoredPlaybook => ({
  id: SEEDED_PLAYBOOK_ID,
  name: "Supplier MSA",
  description: "Inbound supplier master services agreements",
  scope: { perspective: SEEDED_PERSPECTIVE },
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
      // The receiving party of an NDA maps to no perspective value.
      perspectives: [undefined],
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
      perspectives: [SEEDED_PERSPECTIVE],
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
      perspectives: [SEEDED_PERSPECTIVE],
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
      perspectives: [SEEDED_PERSPECTIVE],
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
      perspectives: [SEEDED_PERSPECTIVE],
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
      perspectives: [SEEDED_PERSPECTIVE],
      check: () => [],
    },
  },
];

type ToolTrace = { name: string; input: unknown; result?: unknown };

type ProductionToolName =
  | (typeof TOOL_NAMES)[number]
  | MatterToolName
  | typeof LIST_TEMPLATES_TOOL_NAME;

const PRODUCTION_DEFINITIONS = [
  ...KNOWLEDGE_TOOL_DEFINITIONS,
  ...STELLA_TOOL_DEFINITIONS,
  ...DOCUMENT_TOOL_DEFINITIONS,
  ...TEMPLATE_TOOL_SET.definitions,
];

const definitionOf = (name: ProductionToolName) =>
  PRODUCTION_DEFINITIONS.find((definition) => definition.name === name) ??
  panic(`The static tool registry has no ${name}`);

/**
 * The tool as an MCP client is served it: the wire JSON Schema, and no
 * validation in the transport. Production validates inside the tool site, and
 * a transport that pre-validated would refuse calls the server answers with an
 * envelope, leaving nothing in the trace to score.
 */
const productionTool = (
  name: ProductionToolName,
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

/** The JSON an MCP client reads from a tool result's first text block. */
const payloadOf = (result: ReturnType<typeof serializeToolResult>): unknown => {
  const text = result.content.at(0);
  return text?.type === "text" ? JSON.parse(text.text) : null;
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
    const payload = payloadOf(
      await handleMcpToolCall({
        args: isRecord(input) ? input : {},
        context: store.context,
        toolName: name,
      }),
    );
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

type ModelTurnOptions = {
  model: ResolvedTanStackTextModel;
  messages: ModelMessage[];
  system: string;
  tools: AnyServerTool[];
  iterations: number;
  timeoutMs: number;
  /** Sees every chunk, so a caller can keep the conversation for a later turn. */
  onChunk?: (chunk: PublicStreamChunk) => void;
};

const runModelTurn = async ({
  model,
  messages,
  system,
  tools,
  iterations,
  timeoutMs,
  onChunk,
}: ModelTurnOptions): Promise<ModelTurn> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    role: "fast",
    scopeKey: null,
  });
  const rawCalls: ToolTrace[] = [];
  const callNames = new Map<string, string>();
  let finalText = "";
  const { error, latencyMs, usage } = await runEvalModelTurn({
    timeoutMs,
    chat: (abortController) =>
      streamChatChunks({
        abortController,
        adapter: model.adapter,
        messages,
        agentLoopStrategy: maxIterations(iterations),
        ...systemPromptsPatch({ caching, model, system }),
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
      onChunk?.(chunk);
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
    messages: [{ role: "user", content: task.brief }],
    system: CONTRACT_SYSTEM_PROMPT,
    tools: createTools({ store, task, trace, saveCalls }),
    iterations: MAX_ITERATIONS,
    timeoutMs: MODEL_TURN_TIMEOUT_MS,
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
    finalPerspective: playbook?.scope?.perspective,
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

// --- behavior tier --------------------------------------------------------

const BEHAVIOR_SYSTEM_PREAMBLE =
  "You are stella, an assistant in a legal workspace. You act through the " +
  "tools you are given.";

/** The shipped skill, resolved by the production active-skill path. */
const resolveBehaviorSkill = async (
  store: PlaybookStore,
): Promise<ActiveChatSkillContext> => {
  const resolved = await resolveActiveChatSkillContext({
    activeSkill: { skillName: PLAYBOOK_BUILDER_SKILL },
    memberRole: { role: store.context.memberRole },
    organizationId: store.context.organizationId,
    safeDb: store.context.safeDb,
    userId: store.context.userId,
  });
  if (resolved.isErr()) {
    return panic(
      `The ${PLAYBOOK_BUILDER_SKILL} skill did not resolve`,
      resolved.error,
    );
  }
  return (
    resolved.value ??
    panic(`The ${PLAYBOOK_BUILDER_SKILL} skill resolved to no active skill`)
  );
};

/**
 * Whether a chat turn with `skill` active offers `spawn_subagents`: the
 * production predicate over the skill's frontmatter exclusions, so the eval
 * measures the shipped turn. The prompt's delegation rule and the tool
 * follow it together, as in `send-message.ts`.
 */
const subagentsOfferedWith = (skill: ActiveChatSkillContext): boolean =>
  areSubagentToolsRegistered({
    delegationDepth: 0,
    excludedChatTools: skill.excludedChatTools,
  });

/**
 * The system prompt a chat with the built-in skill active carries, rendered
 * from the shipped `SKILL.md`. On the chat surface the code-mode section for
 * the reads the skill documents and, when the skill does not exclude
 * `spawn_subagents`, the delegation rule precede it, where `buildPromptParts`
 * (`chat-prompt.ts`) places them.
 */
const behaviorSystemPrompt = ({
  skill,
  surface,
}: {
  skill: ActiveChatSkillContext;
  surface: BuilderSurface;
}): string =>
  [
    BEHAVIOR_SYSTEM_PREAMBLE,
    ...(surface === "chat"
      ? [
          chatCodeModeSystemPrompt(skill.documentedChatReads),
          ...(subagentsOfferedWith(skill) ? [SUBAGENT_DELEGATION_SECTION] : []),
        ]
      : []),
    buildActiveSkillSection(skill),
  ].join("\n\n");

const askedQuestionsOf = (input: unknown): AskedQuestion[] => {
  const questions = isRecord(input) ? input["questions"] : undefined;
  if (!Array.isArray(questions)) {
    return [];
  }
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return questions.filter(isRecord).map((question) => {
    const options = question["options"];
    const preset = question["default"];
    return {
      question: text(question["question"]),
      reason: text(question["reason"]),
      options: Array.isArray(options) ? options.map(text) : [],
      default: typeof preset === "string" ? preset : undefined,
    };
  });
};

/**
 * The OpenAI adapter packs a reasoning item's id into the thinking
 * signature as JSON; any other signature is its own key.
 */
const thinkingKeyOf = (signature: string): string => {
  const parsed = Result.try(() => JSON.parse(signature) as unknown);
  const id =
    Result.isOk(parsed) && isRecord(parsed.value)
      ? parsed.value["id"]
      : undefined;
  return typeof id === "string" ? id : signature;
};

/**
 * The SDK's processor files the reasoning step that precedes a run's final
 * text under both the tool-call message and the text message, and OpenAI
 * refuses a replay that names one reasoning item twice. Keep each reasoning
 * item where it first appears.
 */
const withoutRepeatedThinking = (
  messages: readonly ModelMessage[],
): ModelMessage[] => {
  const seen = new Set<string>();
  return messages.map((message) => {
    if (message.thinking === undefined) {
      return message;
    }
    const thinking = message.thinking.filter(({ signature }) => {
      if (signature === undefined) {
        return false;
      }
      const key = thinkingKeyOf(signature);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    if (thinking.length > 0) {
      return { ...message, thinking };
    }
    const { thinking: _repeated, ...rest } = message;
    return rest;
  });
};

const allPositions = (store: PlaybookStore): Position[] =>
  store.playbooks().flatMap(({ positions }) => positions.items);

type Recorder = (
  event: Omit<
    BuilderEvent,
    "questions" | "resentUnchanged" | "error" | "turn"
  > &
    Partial<BuilderEvent>,
) => BuilderEvent;

/**
 * The same tool with every call recorded: the event is pushed before the
 * call runs, so the reads a script makes follow their `execute_typescript`
 * event, and `failureOf` reads the failure off the output afterwards.
 */
const recordedTool = ({
  tool,
  record,
  failureOf,
}: {
  tool: AnyServerTool;
  record: Recorder;
  failureOf: (output: unknown) => string | null;
}): AnyServerTool => {
  const execute = tool.execute ?? panic(`${tool.name} has no server execute`);
  return {
    ...tool,
    execute: async (input: unknown, context?: unknown) => {
      const event = record({ name: tool.name, input });
      const output: unknown = await execute(input, context);
      event.error = failureOf(output);
      return output;
    },
  };
};

/** `execute_typescript` reports a failed run as `{ success: false, error }`. */
const scriptFailureOf = (output: unknown): string | null => {
  if (!isRecord(output) || output["success"] !== false) {
    return null;
  }
  const error = output["error"];
  return isRecord(error)
    ? `${String(error["name"])}: ${String(error["message"])}`
    : "failed";
};

/**
 * The matter reads as an MCP client meets them: direct tools with the
 * production schemas, answered from the fixtures.
 */
const mcpMatterTools = (record: Recorder): AnyServerTool[] =>
  MATTER_TOOL_NAMES.map((name) =>
    productionTool(name, async (input) => {
      const result = answerMatterTool(name, isRecord(input) ? input : {});
      record({
        name,
        input,
        error: result.status === "error" ? result.error.message : null,
      });
      return await Promise.resolve(payloadOf(serializeToolResult(result)));
    }),
  );

/**
 * The matter reads as the stella chat serves them: `external_*` functions
 * inside `execute_typescript`, documented by `discover_tools`, run through
 * the production registry runner (ref dehydration, boundary normalization,
 * egress, strict projection) with the fixtures standing in for the handlers.
 * The playbook read in a script is the production handler over the store,
 * as it is in chat. Any other read is unavailable, as a read behind a
 * disabled feature is in chat.
 */
const chatMatterTools = ({
  store,
  record,
  skill,
}: {
  store: PlaybookStore;
  record: Recorder;
  skill: ActiveChatSkillContext;
}): AnyServerTool[] => {
  const refRegistry = createChatRefRegistry();
  const listPlaybooks =
    getStaticMcpToolHandler(LIST_PLAYBOOKS) ??
    panic(`The static tool registry has no ${LIST_PLAYBOOKS} handler`);
  const runReadTool: ChatCodeModeReadRunner = async (toolName, args) => {
    // The handler's view of the call: refs already resolved to ids, so the
    // scenario checks read the same input on both surfaces. A call refused
    // before the handler keeps the input the script wrote.
    let handlerArgs: Record<string, unknown> | undefined;
    const answerMatterRead: McpToolHandler = ({ args: normalized }) => {
      handlerArgs = normalized;
      return isMatterToolName(toolName)
        ? answerMatterTool(toolName, normalized)
        : panic(`${toolName} is not a matter read`);
    };
    const handlerFor = (): McpToolHandler | null => {
      if (isMatterToolName(toolName)) {
        return answerMatterRead;
      }
      return toolName === LIST_PLAYBOOKS ? listPlaybooks : null;
    };
    const handler = handlerFor();
    if (handler === null) {
      const error = new ChatToolError({
        kind: "unavailable",
        message: `${toolName} has nothing to read in this eval.`,
      });
      record({ name: toolName, input: args, error: error.message });
      throw error;
    }
    const result = await runRegistryReadTool({
      toolName,
      args,
      context: store.context,
      refRegistry,
      handler,
    });
    if (Result.isError(result)) {
      record({
        name: toolName,
        input: handlerArgs ?? args,
        error: `${result.error.kind}: ${result.error.message}`,
      });
      throw result.error;
    }
    record({ name: toolName, input: handlerArgs ?? args });
    return result.value;
  };
  const { tool, discoveryTool } = createChatCodeModeSurface({
    concurrencyKey: EVAL_SANDBOX_KEY,
    documentedReads: skill.documentedChatReads,
    runReadTool,
  });
  const discovery =
    discoveryTool ??
    panic(
      `chat code mode always has lazy reads, so ${DISCOVER_TOOLS} must exist`,
    );
  return [
    recordedTool({ tool, record, failureOf: scriptFailureOf }),
    recordedTool({ tool: discovery, record, failureOf: () => null }),
    ...(subagentsOfferedWith(skill)
      ? [
          recordedTool({
            tool: spawnSubagentsStub(),
            record,
            failureOf: () => null,
          }),
        ]
      : []),
  ];
};

/**
 * `spawn_subagents` as chat registers it when the skill does not exclude it,
 * so a run can reach for it; each subtask comes back failed, so the run has
 * to do the work itself and the rest of the flow is still scored. The call
 * itself is a defect.
 */
const spawnSubagentsStub = (): AnyServerTool =>
  SPAWN_SUBAGENTS_TOOL_DEFINITION.server(({ subagents }) => ({
    results: subagents.map((_subagent, index) => ({
      index,
      status: "failed" as const,
      error: "Subagents do not run in this eval; do the work yourself.",
    })),
  }));

/**
 * `list_templates` as each surface offers it, answering with the dev
 * database's empty library. The skill mentions starter playbooks and never
 * looks for them, so the call itself is a defect.
 */
const listTemplatesStub = ({
  surface,
  record,
}: {
  surface: BuilderSurface;
  record: Recorder;
}): AnyServerTool => {
  const answer = (input: unknown) => {
    record({ name: LIST_TEMPLATES_TOOL_NAME, input });
    return { templates: [] };
  };
  return surface === "chat"
    ? LIST_TEMPLATES_TOOL_DEFINITION.server(answer)
    : productionTool(
        LIST_TEMPLATES_TOOL_NAME,
        async (input) => await Promise.resolve(answer(input)),
      );
};

const createBehaviorTools = ({
  store,
  scenario,
  skill,
  surface,
  events,
  currentTurn,
}: {
  store: PlaybookStore;
  scenario: BuilderScenario;
  skill: ActiveChatSkillContext;
  surface: BuilderSurface;
  events: BuilderEvent[];
  currentTurn: () => number;
}): AnyServerTool[] => {
  const record: Recorder = (event) => {
    const recorded: BuilderEvent = {
      turn: currentTurn(),
      questions: [],
      resentUnchanged: [],
      error: null,
      ...event,
    };
    events.push(recorded);
    return recorded;
  };

  const callRegistry = async (
    name: (typeof TOOL_NAMES)[number],
    input: unknown,
  ): Promise<unknown> => {
    const before = allPositions(store);
    const payload = payloadOf(
      await handleMcpToolCall({
        args: isRecord(input) ? input : {},
        context: store.context,
        toolName: name,
      }),
    );
    record({
      name,
      input,
      error: errorCodeOf(payload),
      resentUnchanged:
        name === SAVE_PLAYBOOK
          ? findUnchangedResends({ input, before, after: allPositions(store) })
          : [],
    });
    return payload;
  };

  const askUser = createOrgTools({
    accessibleWorkspaceIds: store.context.accessibleWorkspaceIds,
    organizationId: store.context.organizationId,
    scopedDb: store.context.scopedDb,
  })[ASK_USER_TOOL_NAME].server((input) => {
    const questions = askedQuestionsOf(input);
    record({ name: ASK_USER_TOOL_NAME, input, questions });
    return {
      answers: questions.map((question) => ({
        question: question.question,
        answer: scenario.answer(question, events),
      })),
    };
  });

  const matterTools =
    surface === "chat"
      ? chatMatterTools({ store, record, skill })
      : mcpMatterTools(record);

  return [
    ...TOOL_NAMES.map((name) =>
      productionTool(name, async (input) => await callRegistry(name, input)),
    ),
    ...matterTools,
    listTemplatesStub({ surface, record }),
    askUser,
  ];
};

type BehaviorRun = {
  model: string;
  scenario: string;
  surface: BuilderSurface;
  run: number;
  outcome: "pass" | "fail" | "error";
  defects: string[];
  events: BuilderEvent[];
  /** The conversation as the last turn replayed it, for `--json`. */
  transcript: ModelMessage[];
  finalText: string;
  /** Summed over the scenario's turns. */
  latencyMs: number;
  tokens: number;
};

const runScenario = async ({
  model,
  modelId,
  repeat,
  scenario,
  surface,
}: {
  model: ResolvedTanStackTextModel;
  modelId: string;
  repeat: number;
  scenario: BuilderScenario;
  surface: BuilderSurface;
}): Promise<BehaviorRun> => {
  const store = createPlaybookStore([]);
  const events: BuilderEvent[] = [];
  const skill = await resolveBehaviorSkill(store);
  const system = behaviorSystemPrompt({ skill, surface });
  // The SDK's own processor keeps the conversation, so a follow-up turn
  // carries the assistant's text, tool calls, and tool results the way a
  // chat client sends them back.
  const { processor: conversation } = createStreamMessageCapture({
    initialMessages: [],
    capture: () => null,
  });
  let turnNumber = 0;
  const tools = createBehaviorTools({
    store,
    scenario,
    skill,
    surface,
    events,
    currentTurn: () => turnNumber,
  });
  let error: string | null = null;
  let finalText = "";
  const replies: string[] = [];
  let latencyMs = 0;
  let tokens = 0;
  for (const message of [scenario.brief, ...scenario.followUps]) {
    turnNumber += 1;
    conversation.addUserMessage(message);
    conversation.prepareAssistantMessage();
    const turn = await runModelTurn({
      model,
      messages: withoutRepeatedThinking(conversation.toModelMessages()),
      system,
      tools,
      iterations: BEHAVIOR_MAX_ITERATIONS,
      timeoutMs: BEHAVIOR_TURN_TIMEOUT_MS,
      onChunk: (chunk) => conversation.processChunk(chunk),
    });
    finalText = turn.finalText;
    replies.push(turn.finalText);
    latencyMs += turn.latencyMs;
    tokens += turn.usage?.totalTokens ?? 0;
    if (turn.error !== null) {
      error = turn.error;
      break;
    }
  }
  const playbooks = store.playbooks();
  const defects = scoreScenario(scenario, {
    surface,
    documentedReads: new Set(skill.documentedChatReads),
    events,
    replies,
    playbooks,
  });
  // What the tool stored must be what the HTTP route would have accepted.
  if (
    playbooks.some(
      ({ positions }) => !Value.Check(playbookPositionsSchema, positions),
    )
  ) {
    defects.push("the stored positions do not parse as positionSchema");
  }
  let outcome: BehaviorRun["outcome"] = defects.length === 0 ? "pass" : "fail";
  if (error !== null) {
    outcome = "error";
    defects.unshift(error);
  }
  return {
    model: modelId,
    scenario: scenario.id,
    surface,
    run: repeat,
    outcome,
    defects,
    events,
    transcript: withoutRepeatedThinking(conversation.toModelMessages()),
    finalText,
    latencyMs,
    tokens,
  };
};

const renderBehaviorReport = (runs: readonly BehaviorRun[]): string => {
  const lines: string[] = ["# playbook-authoring (behavior tier)"];
  for (const modelId of new Set(runs.map((run) => run.model))) {
    const modelRuns = runs.filter((run) => run.model === modelId);
    lines.push(
      `\n### ${modelId}\n`,
      "| scenario | surface | run | outcome | questions | scripts | reads | spawns | saves | defects | tokens | ms |",
      "| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
    );
    for (const run of modelRuns) {
      const count = (predicate: (event: BuilderEvent) => boolean) =>
        String(run.events.filter(predicate).length);
      lines.push(
        `| ${run.scenario} | ${run.surface} | ${String(run.run)} | ${run.outcome} | ${count(({ name }) => name === ASK_USER_TOOL_NAME)} | ${count(({ name }) => name === EXECUTE_TYPESCRIPT)} | ${count(({ name }) => name === "read_content_across_matters")} | ${count(({ name }) => name === SPAWN_SUBAGENTS_TOOL_NAME)} | ${count(({ name }) => name === SAVE_PLAYBOOK)} | ${cell(run.defects)} | ${String(run.tokens)} | ${String(run.latencyMs)} |`,
      );
    }
    const passed = modelRuns.filter((run) => run.outcome === "pass");
    lines.push(
      "",
      `passed ${String(passed.length)}/${String(modelRuns.length)}`,
    );
  }
  return lines.join("\n");
};

type CliOptions = {
  models: string[];
  runs: number;
  tiers: readonly Tier[];
  /** Behavior tier only: which surfaces the matter reads take. */
  surfaces: readonly BuilderSurface[];
  taskFilter: string | null;
  jsonPath: string | null;
};

const isTier = (value: string): value is Tier =>
  TIERS.some((tier) => tier === value);

const isSurface = (value: string): value is BuilderSurface =>
  BUILDER_SURFACES.some((surface) => surface === value);

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    models: DEFAULT_EVAL_MODELS,
    runs: DEFAULT_RUNS,
    tiers: TIERS,
    surfaces: BUILDER_SURFACES,
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
      case "--tier":
        options.tiers = isTier(value)
          ? [value]
          : panic(`--tier takes ${TIERS.join(" or ")}`);
        index += 1;
        break;
      case "--surface":
        options.surfaces = isSurface(value)
          ? [value]
          : panic(`--surface takes ${BUILDER_SURFACES.join(" or ")}`);
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

const renderContractReport = (runs: readonly EvalRun[]): string => {
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
  const matches = (id: string) =>
    options.taskFilter === null || id === options.taskFilter;
  const tasks = options.tiers.includes("contract")
    ? TASKS.filter((task) => matches(task.id))
    : [];
  const scenarios = options.tiers.includes("behavior")
    ? BUILDER_SCENARIOS.filter((scenario) => matches(scenario.id))
    : [];
  if (tasks.length === 0 && scenarios.length === 0) {
    panic(`No task or scenario is named ${String(options.taskFilter)}`);
  }

  const runs: EvalRun[] = [];
  const behaviorRuns: BehaviorRun[] = [];
  for (const { id, model } of await resolveModels(options.models)) {
    for (const task of tasks) {
      for (let repeat = 1; repeat <= options.runs; repeat += 1) {
        process.stderr.write(`${id} · ${task.id} · run ${String(repeat)}\n`);
        runs.push(await runTask({ model, modelId: id, repeat, task }));
      }
    }
    for (const scenario of scenarios) {
      for (const surface of options.surfaces) {
        for (let repeat = 1; repeat <= options.runs; repeat += 1) {
          process.stderr.write(
            `${id} · ${scenario.id} · ${surface} · run ${String(repeat)}\n`,
          );
          behaviorRuns.push(
            await runScenario({
              model,
              modelId: id,
              repeat,
              scenario,
              surface,
            }),
          );
        }
      }
    }
  }

  const reports = [
    ...(runs.length > 0 ? [renderContractReport(runs)] : []),
    ...(behaviorRuns.length > 0 ? [renderBehaviorReport(behaviorRuns)] : []),
  ];
  process.stdout.write(`${reports.join("\n\n")}\n`);
  if (options.jsonPath !== null) {
    await writeFile(
      options.jsonPath,
      JSON.stringify({ runs, behaviorRuns }, null, 2),
    );
  }
};

await main();
// The tool registry import leaves a database handle open, which would keep
// the process alive after the report is written.
process.exit(0);
