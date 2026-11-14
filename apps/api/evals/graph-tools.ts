/**
 * Graph tools eval: can a model answer questions about a matter through the
 * graph's three query tools (`lists.graph.nodes.list`,
 * `lists.graph.neighbours.list`, `lists.graph.paths.list`) given only their
 * descriptions and schemas? Each call is parsed by the handler's own query
 * schema and answered by the handler itself, over the synthetic case
 * (`lib/graph-tools-case.ts`) seeded into an in-process database. Scores the
 * steps separately (`lib/graph-tools-score.ts`): looked up first, navigated
 * by returned ids only, used the direct filter, quoted the exact text. A
 * rejected call is kept whole with its issues.
 *
 * Calls real models, so it never runs without an explicit model list:
 *
 *   bun run eval:graph-tools -- --models anthropic::claude-sonnet-5 --runs 3
 *   bun run eval:graph-tools -- --models <id> --task en-conflict-quote --json out.json
 */

import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyServerTool } from "@tanstack/ai";
import { panic } from "better-result";
import { writeFile } from "node:fs/promises";
import * as v from "valibot";

import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import listGraphNeighbours from "@/api/handlers/lists/graph/neighbours/list";
import listGraphNodes from "@/api/handlers/lists/graph/nodes/list";
import listGraphPaths from "@/api/handlers/lists/graph/paths/list";
import { resolveCaching } from "@/api/lib/ai-config";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { isRecord } from "@/api/lib/type-guards";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import {
  seedGraphCase,
  seedGraphReviewer,
} from "@/api/tests/helpers/graph-case";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { getTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { GRAPH_EVAL_TASKS } from "./lib/graph-tools-case";
import type { GraphEvalTask } from "./lib/graph-tools-case";
import { GRAPH_TOOL_NAMES, scoreGraphRun } from "./lib/graph-tools-score";
import type { GraphRunScore, GraphToolCall } from "./lib/graph-tools-score";
import { runEvalModelTurn } from "./lib/model-turn";

const MAX_ITERATIONS = 8;
const MAX_OUTPUT_TOKENS = 2000;
const MODEL_REQUEST_TIMEOUT_MS = 180_000;

const SYSTEM_PROMPT = [
  "You are stella, a legal assistant answering questions about one matter.",
  "The matter's facts, the claims found in its documents and the documents",
  "the facts come from form a graph you read with the tools given. Answer",
  "only from what the tools return, quote the exact text they give, and",
  "answer in the language of the question.",
].join(" ");

type CliOptions = {
  models: string[];
  runs: number;
  taskFilter: string | null;
  jsonPath: string | null;
};

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    models: [],
    runs: 1,
    taskFilter: null,
    jsonPath: null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv.at(index) ?? panic("An argument index ran past argv");
    const value = argv.at(index + 1);
    if (value === undefined) {
      return panic(`Flag ${flag} needs a value`);
    }
    switch (flag) {
      case "--models": {
        options.models = value.split(",").filter(Boolean);
        break;
      }
      case "--runs": {
        options.runs = Number.parseInt(value, 10);
        break;
      }
      case "--task": {
        options.taskFilter = value;
        break;
      }
      case "--json": {
        options.jsonPath = value;
        break;
      }
      default: {
        return panic(`Unknown argument ${flag}`);
      }
    }
  }
  return options;
};

/** Every node id a tool result names, which later calls may navigate by. */
const idsIn = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(idsIn);
  }
  if (!isRecord(value)) {
    return [];
  }
  return [
    ...(typeof value["id"] === "string" && typeof value["kind"] === "string"
      ? [value["id"]]
      : []),
    ...Object.values(value).flatMap(idsIn),
  ];
};

type Matter = {
  db: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const seedMatter = async (): Promise<Matter> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
  const workspaceId = createSafeId<"workspace">();
  env.FEATURE_LEGAL_LISTS = true;
  env.API_FEATURE_ACCESS_GRANTS = organizationFeatureGrants(organizationId, [
    LEGAL_LISTS_FEATURE_ID,
    LIST_VERIFICATION_FEATURE_ID,
  ]);
  const db = await getTestDb();
  await seedGraphReviewer({ db, organizationId, userId });
  await seedGraphCase({
    db,
    organizationId,
    userId,
    workspaceId,
    reference: Bun.randomUUIDv7().slice(-8),
  });
  return { db, organizationId, userId, workspaceId };
};

type ToolOutcome =
  | { type: "rejected"; issues: readonly v.BaseIssue<unknown>[] }
  | { type: "handled"; result: unknown };

/** The context a handler runs in for the eval's reviewer, in the matter. */
const handlerContext = (matter: Matter) => ({
  audit: auditRecorderDouble(),
  scopedDb: NO_DB,
  workspaceId: matter.workspaceId,
  session: { activeOrganizationId: matter.organizationId },
  user: { id: matter.userId },
  safeDb: createSafeDb(
    matter.db,
    [matter.workspaceId],
    matter.organizationId,
    matter.userId,
  ),
});

/** Each tool parses its input with its handler's own schema, then runs the
 *  handler: the call a model makes is the call a transport makes. */
const RUNNERS = {
  [GRAPH_TOOL_NAMES.nodes]: async (matter: Matter, input: unknown) => {
    const parsed = v.safeParse(listGraphNodes.config.query, input);
    return parsed.success
      ? {
          type: "handled",
          result: await listGraphNodes.handler(
            createTestHandlerContext<
              Parameters<typeof listGraphNodes.handler>[0]
            >({ ...handlerContext(matter), query: parsed.output }),
          ),
        }
      : { type: "rejected", issues: parsed.issues };
  },
  [GRAPH_TOOL_NAMES.neighbours]: async (matter: Matter, input: unknown) => {
    const parsed = v.safeParse(listGraphNeighbours.config.query, input);
    return parsed.success
      ? {
          type: "handled",
          result: await listGraphNeighbours.handler(
            createTestHandlerContext<
              Parameters<typeof listGraphNeighbours.handler>[0]
            >({ ...handlerContext(matter), query: parsed.output }),
          ),
        }
      : { type: "rejected", issues: parsed.issues };
  },
  [GRAPH_TOOL_NAMES.paths]: async (matter: Matter, input: unknown) => {
    const parsed = v.safeParse(listGraphPaths.config.query, input);
    return parsed.success
      ? {
          type: "handled",
          result: await listGraphPaths.handler(
            createTestHandlerContext<
              Parameters<typeof listGraphPaths.handler>[0]
            >({ ...handlerContext(matter), query: parsed.output }),
          ),
        }
      : { type: "rejected", issues: parsed.issues };
  },
} as const satisfies Record<
  (typeof GRAPH_TOOL_NAMES)[keyof typeof GRAPH_TOOL_NAMES],
  (matter: Matter, input: unknown) => Promise<ToolOutcome>
>;

const HANDLERS = {
  [GRAPH_TOOL_NAMES.nodes]: listGraphNodes,
  [GRAPH_TOOL_NAMES.neighbours]: listGraphNeighbours,
  [GRAPH_TOOL_NAMES.paths]: listGraphPaths,
} as const;

const createGraphTools = (
  matter: Matter,
  calls: GraphToolCall[],
): AnyServerTool[] =>
  Object.values(GRAPH_TOOL_NAMES).map((name) =>
    toolDefinition({
      name,
      description: HANDLERS[name].config.description,
      inputSchema: toTanStackToolSchema(HANDLERS[name].config.query),
    }).server(async (input: unknown) => {
      const outcome: ToolOutcome = await RUNNERS[name](matter, input);
      if (outcome.type === "rejected") {
        calls.push({
          name,
          input,
          rejected: outcome.issues.map((issue) => issue.message),
          returnedIds: [],
        });
        return {
          error: {
            code: "validation_error",
            issues: outcome.issues.map((issue) => ({
              path: v.getDotPath(issue),
              message: issue.message,
            })),
          },
        };
      }
      calls.push({
        name,
        input,
        rejected: null,
        returnedIds: idsIn(outcome.result),
      });
      return outcome.result;
    }),
  );

type EvalRun = {
  modelId: string;
  taskId: string;
  repeat: number;
  error: string | null;
  answer: string;
  calls: GraphToolCall[];
  score: GraphRunScore;
};

const runTask = async ({
  model,
  modelId,
  task,
  repeat,
  matter,
}: {
  model: ResolvedTanStackTextModel;
  modelId: string;
  task: GraphEvalTask;
  repeat: number;
  matter: Matter;
}): Promise<EvalRun> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    task: "short-text",
    scopeKey: null,
  });
  const calls: GraphToolCall[] = [];
  let answer = "";
  const { error } = await runEvalModelTurn({
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    chat: (abortController) =>
      streamChatChunks({
        abortController,
        adapter: model.adapter,
        messages: [{ role: "user", content: task.prompt }],
        agentLoopStrategy: maxIterations(MAX_ITERATIONS),
        ...systemPromptsPatch({ caching, model, system: SYSTEM_PROMPT }),
        modelOptions: mergeGenerationOptions({
          caching,
          model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          serviceTier: "standard",
          temperature: 0,
        }),
        tools: createGraphTools(matter, calls),
      }),
    onChunk: (chunk) => {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        answer += chunk.delta;
      }
    },
  });
  return {
    modelId,
    taskId: task.id,
    repeat,
    error,
    answer,
    calls,
    score: scoreGraphRun(task, calls, answer),
  };
};

const resolveModels = async (
  modelIds: readonly string[],
): Promise<{ id: string; model: ResolvedTanStackTextModel }[]> => {
  const { resolveTanStackTextModel } =
    await import("@/api/lib/tanstack-ai-generate");
  return await Promise.all(
    modelIds.map(async (id) => ({
      id,
      model: await resolveTanStackTextModel({
        userId: null,
        modelId: id,
        orgAIConfig: null,
        dataClass: "customer",
        managedAIResidency: "eu",
        task: "short-text",
        organizationId: null,
        admission: NO_ORGANIZATION_MODEL_DISPATCH,
      }),
    })),
  );
};

const STEPS = [
  "found",
  "grounded",
  "navigated",
  "filtered",
  "answered",
] as const;

const renderReport = (runs: readonly EvalRun[]): string => {
  const header = `| model | task | ${STEPS.join(" | ")} | rejected | calls |`;
  const rule = `|${" --- |".repeat(STEPS.length + 4)}`;
  const mark = (value: boolean | null) => {
    if (value === null) {
      return "n/a";
    }
    return value ? "yes" : "no";
  };
  const rows = runs.map(
    (run) =>
      `| ${run.modelId} | ${run.taskId} | ${STEPS.map((step) => mark(run.score[step])).join(" | ")} | ${String(run.score.rejectedCalls)} | ${String(run.score.calls)} |`,
  );
  return [header, rule, ...rows].join("\n");
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.models.length === 0) {
    process.stderr.write(
      "No model given. This eval calls real models, so it runs only with an explicit --models list.\n",
    );
    process.exit(2);
  }
  const tasks = GRAPH_EVAL_TASKS.filter(
    (task) => options.taskFilter === null || task.id === options.taskFilter,
  );
  if (tasks.length === 0) {
    panic(`Unknown task ${String(options.taskFilter)}`);
  }
  const matter = await seedMatter();
  const models = await resolveModels(options.models);
  const runs: EvalRun[] = [];
  for (const { id, model } of models) {
    for (const task of tasks) {
      for (let repeat = 1; repeat <= options.runs; repeat += 1) {
        process.stderr.write(`${id} · ${task.id} · run ${String(repeat)}\n`);
        runs.push(await runTask({ model, modelId: id, task, repeat, matter }));
      }
    }
  }
  process.stdout.write(`${renderReport(runs)}\n`);
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify({ runs }, null, 2));
  }
};

await main();
