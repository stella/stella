import {
  convertSchemaToJsonSchema,
  EventType,
  maxIterations,
  toolDefinition,
} from "@tanstack/ai";
import type { StreamChunk, TokenUsage } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import * as v from "valibot";

import { BYOK_DEFAULT_MODELS, BYOK_MODEL_OPTIONS } from "@stll/ai-catalog";

import { classifyRunErrorChunk } from "@/api/handlers/chat/stream-chat";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { getTemperatureForRole } from "@/api/lib/ai-config";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { chatToolMapToArray } from "@/api/lib/chat/chat-tool-types";
import { projectChatToolSchemasForProvider } from "@/api/lib/chat/provider-tool-projection";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import {
  chatTurnOutputTokens,
  mergeGenerationOptions,
} from "@/api/lib/tanstack-ai-generate";
import {
  clearByokAdapterCache,
  createTanStackTextAdapterFactory,
  getTanStackTextModelForRole,
} from "@/api/lib/tanstack-ai-models";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import { WIRE_TOOL_NAME } from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireCassette,
  ProviderWireProvider,
  ProviderWireScenario,
} from "@/api/tests/helpers/provider-wire-cassette";
import { encodeAwsEventStreamMessage } from "@/api/tests/helpers/provider-wire-replay";
import type {
  ProviderWireReplay,
  ProviderWireReplayFindings,
} from "@/api/tests/helpers/provider-wire-replay";

// One contract for every provider adapter. A run sends the fixed synthetic
// request for a scenario through the real adapter, as the chat engine would
// hand it over (production model options, the provider's tool projection,
// the engine's schema conversion), and collects the normalized events. The
// recorder sends the same request to the live provider, so a recording and
// its replay differ only in who answers.

/** The declared input of the wire tool: `note` is optional, so a strict
 *  provider widens it to `null` on the wire. */
export const WIRE_TOOL_INPUT = v.object({
  name: v.string(),
  note: v.optional(v.string()),
});

export const wireTool = () =>
  toolDefinition({
    name: WIRE_TOOL_NAME,
    description: "Delete a draft by name.",
    inputSchema: toTanStackToolSchema(WIRE_TOOL_INPUT),
  });

const TEXT_PROMPT =
  "Reply with exactly this sentence and nothing else: The cassette plays.";

/** The one user message each scenario sends. Recordings capture exactly
 *  these prompts and nothing else. */
export const SCENARIO_PROMPTS = {
  text: TEXT_PROMPT,
  "text-terminal-only": TEXT_PROMPT,
  "tool-call": `Call the ${WIRE_TOOL_NAME} tool once with name "draft". Do not write any text.`,
  "parallel-tool-calls": `Call the ${WIRE_TOOL_NAME} tool twice in parallel, in one response: once with name "draft" and once with name "memo". Do not write any text.`,
  "strict-null": `Call the ${WIRE_TOOL_NAME} tool once with name "draft" and note set to JSON null. Do not write any text.`,
  length: "Count from 1 to 500 in words, separated by commas.",
  refusal: TEXT_PROMPT,
  "bad-request": TEXT_PROMPT,
  "rate-limit": TEXT_PROMPT,
  "server-error": TEXT_PROMPT,
  "malformed-chunk": TEXT_PROMPT,
  "early-eof": TEXT_PROMPT,
} as const satisfies Record<ProviderWireScenario, string>;

/** The output ceiling the length scenario asks for. */
const LENGTH_SCENARIO_MAX_TOKENS = 16;
/** A model id no provider serves, for the rejected request. */
export const UNKNOWN_MODEL_ID = "stella-cassette-no-such-model";

/** The chat model a provider's corpus is recorded with. */
export const wireChatModel = (provider: ProviderWireProvider): string =>
  BYOK_DEFAULT_MODELS[provider].chat;

/** A second model of the provider's, for side calls such as thread titles. */
export const wireSideModel = (provider: ProviderWireProvider): string => {
  const chat = wireChatModel(provider);
  const options: readonly string[] = BYOK_MODEL_OPTIONS[provider];
  return options.find((model) => model !== chat) ?? chat;
};

/** An organization that answers every role from `provider`'s own key. */
export const wireOrgAIConfig = ({
  apiKey,
  chatModel,
  provider,
  sideModel,
}: {
  apiKey: string;
  chatModel: string;
  provider: ProviderWireProvider;
  sideModel?: string | undefined;
}): OrgAIConfig => {
  const chat = { provider, modelId: chatModel };
  const side = { provider, modelId: sideModel ?? chatModel };
  return {
    providers: [{ provider, apiKey }],
    overrideModels: { chat, fast: side, pdf: side, reasoning: side },
    decision: null,
  };
};

export type WireRun = {
  chunks: StreamChunk[];
  /** How long the run took after the cancel, when it was cancelled. */
  cancelSettledMs: number | null;
  /** The run was still going at its deadline. */
  overdue?: boolean | undefined;
  thrown: unknown;
};

/**
 * The scenario's synthetic request as the chat engine hands it to
 * `provider`'s real adapter: our model resolution and production model
 * options, the provider's tool projection.
 */
const prepareWireRequest = ({
  apiKey,
  model,
  provider,
  scenario,
}: {
  apiKey: string;
  model: string;
  provider: ProviderWireProvider;
  scenario: ProviderWireScenario;
}) => {
  clearByokAdapterCache();
  // The rejected request names a model no provider serves, so its options
  // come from the provider's chat default.
  const resolved = getTanStackTextModelForRole(
    "chat",
    wireOrgAIConfig({
      apiKey,
      chatModel: scenario === "bad-request" ? wireChatModel(provider) : model,
      provider,
    }),
    { organizationId: null },
  );
  const adapter =
    resolved.modelId === model
      ? resolved.adapter
      : createTanStackTextAdapterFactory({ apiKey, provider })(model);
  const modelOptions = mergeGenerationOptions({
    caching: { enabled: false, reason: "org-disabled" },
    model: resolved,
    maxOutputTokens:
      scenario === "length"
        ? LENGTH_SCENARIO_MAX_TOKENS
        : chatTurnOutputTokens(resolved),
    serviceTier: "standard",
    temperature: getTemperatureForRole("chat"),
  });
  const tools = projectChatToolSchemasForProvider({
    modelTools: chatToolMapToArray({ [WIRE_TOOL_NAME]: wireTool() }),
    provider,
  });
  return {
    adapter,
    messages: [{ role: "user" as const, content: SCENARIO_PROMPTS[scenario] }],
    modelOptions,
    tools,
  };
};

/**
 * Sends the scenario's synthetic request through `provider`'s real adapter
 * and collects the events it yields, converting the tool schemas the way
 * the engine does before it calls an adapter.
 */
export const runWireScenario = async (options: {
  apiKey: string;
  model: string;
  provider: ProviderWireProvider;
  scenario: ProviderWireScenario;
}): Promise<WireRun> => {
  const { adapter, messages, modelOptions, tools } =
    prepareWireRequest(options);
  const abortController = new AbortController();
  const chunks: StreamChunk[] = [];
  const adapterTools = [];
  for (const tool of tools) {
    adapterTools.push({
      ...tool,
      inputSchema:
        tool.inputSchema === undefined
          ? undefined
          : convertSchemaToJsonSchema(tool.inputSchema),
    });
  }
  let thrown: unknown;
  const run = (async () => {
    try {
      for await (const chunk of adapter.chatStream({
        logger: resolveDebugOption(false),
        messages,
        model: options.model,
        modelOptions,
        request: { signal: abortController.signal },
        runId: "wire-run",
        threadId: "wire-thread",
        tools: adapterTools,
      })) {
        chunks.push(chunk);
      }
    } catch (error) {
      thrown = error;
    }
    return "settled" as const;
  })();
  // A run still going at the deadline is cancelled and reported, rather
  // than left to hang the suite.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const ending = await Promise.race([
    run,
    new Promise<"overdue">((resolve) => {
      deadline = setTimeout(() => {
        resolve("overdue");
      }, RUN_DEADLINE_MS);
    }),
  ]);
  clearTimeout(deadline);
  if (ending === "overdue") {
    abortController.abort();
    await Promise.race([run, Bun.sleep(CANCEL_ABANDON_MS)]);
  }
  return {
    cancelSettledMs: null,
    chunks: [...chunks],
    overdue: ending === "overdue",
    thrown,
  };
};

/** Longer than any SDK's default retries of a failure take. */
const RUN_DEADLINE_MS = 15_000;

/**
 * The same request through the chat engine, cancelled the way a chat turn
 * is (its abort controller) once the first text delta arrives. The engine
 * is what production reads a cancelled run through.
 */
export const runCancelledWireScenario = async (options: {
  apiKey: string;
  model: string;
  provider: ProviderWireProvider;
  scenario: ProviderWireScenario;
}): Promise<WireRun> => {
  const { adapter, messages, modelOptions, tools } =
    prepareWireRequest(options);
  const abortController = new AbortController();
  const chunks: StreamChunk[] = [];
  // Written from inside the run, so held in an object the run shares.
  const state: { cancelledAt: number | null; thrown: unknown } = {
    cancelledAt: null,
    thrown: undefined,
  };
  const run = (async () => {
    try {
      for await (const chunk of streamChatChunks({
        abortController,
        adapter,
        agentLoopStrategy: maxIterations(1),
        messages,
        modelOptions,
        runId: "wire-run",
        threadId: "wire-thread",
        tools,
      })) {
        chunks.push(chunk);
        if (
          state.cancelledAt === null &&
          chunk.type === EventType.TEXT_MESSAGE_CONTENT
        ) {
          state.cancelledAt = performance.now();
          abortController.abort();
        }
      }
    } catch (error) {
      state.thrown = error;
    }
    return "settled" as const;
  })();
  // A run that ignores the cancel is abandoned past the deadline; the body
  // the replay holds open is never released, so it never finishes.
  const abandoned = new Promise<"abandoned">((resolve) => {
    abortController.signal.addEventListener(
      "abort",
      () => {
        setTimeout(() => {
          resolve("abandoned");
        }, CANCEL_ABANDON_MS);
      },
      { once: true },
    );
  });
  const ending = await Promise.race([run, abandoned]);
  let cancelSettledMs: number | null = null;
  if (state.cancelledAt !== null) {
    cancelSettledMs =
      ending === "abandoned"
        ? Number.POSITIVE_INFINITY
        : performance.now() - state.cancelledAt;
  }
  return { cancelSettledMs, chunks: [...chunks], thrown: state.thrown };
};

/** How long a cancelled run is waited for before it is abandoned. */
const CANCEL_ABANDON_MS = 5000;

// --- The contract -----------------------------------------------------------

const TERMINAL_TYPES = new Set<string>([
  EventType.RUN_ERROR,
  EventType.RUN_FINISHED,
]);
const DECLARED_FINISH_REASONS = new Set<unknown>([
  "content_filter",
  "length",
  "stop",
  "tool_calls",
]);
/** A cancelled run ends well inside this. */
const CANCEL_SETTLE_MS = 2000;

type RunFinished = Extract<StreamChunk, { type: EventType.RUN_FINISHED }>;
type RunError = Extract<StreamChunk, { type: EventType.RUN_ERROR }>;

const isRunFinished = (chunk: StreamChunk): chunk is RunFinished =>
  chunk.type === EventType.RUN_FINISHED;
const isRunError = (chunk: StreamChunk): chunk is RunError =>
  chunk.type === EventType.RUN_ERROR;

const textOf = (chunks: readonly StreamChunk[]): string =>
  chunks
    .flatMap((chunk) =>
      chunk.type === EventType.TEXT_MESSAGE_CONTENT ? [chunk.delta] : [],
    )
    .join("");

type ToolCallSummary = {
  argumentDeltas: string;
  id: string;
  input: unknown;
  name: string | undefined;
  ended: boolean;
};

const toolCallsOf = (chunks: readonly StreamChunk[]): ToolCallSummary[] => {
  const calls = new Map<string, ToolCallSummary>();
  for (const chunk of chunks) {
    if (chunk.type === EventType.TOOL_CALL_START) {
      calls.set(chunk.toolCallId, {
        argumentDeltas: "",
        ended: false,
        id: chunk.toolCallId,
        input: undefined,
        name: chunk.toolCallName,
      });
    }
    if (chunk.type === EventType.TOOL_CALL_ARGS) {
      const call = calls.get(chunk.toolCallId);
      if (call !== undefined) {
        call.argumentDeltas += chunk.delta;
      }
    }
    if (chunk.type === EventType.TOOL_CALL_END) {
      const call = calls.get(chunk.toolCallId) ?? {
        argumentDeltas: "",
        ended: false,
        id: chunk.toolCallId,
        input: undefined,
        name: undefined,
      };
      call.ended = true;
      call.input = chunk.input;
      calls.set(chunk.toolCallId, call);
    }
  }
  return [...calls.values()];
};

const usageProblems = (usage: TokenUsage | undefined): string[] => {
  if (usage === undefined) {
    return ["the finished run reports no usage"];
  }
  const fields = {
    completionTokens: usage.completionTokens,
    promptTokens: usage.promptTokens,
    totalTokens: usage.totalTokens,
  };
  const problems = Object.entries(fields)
    .filter(([, value]) => !Number.isSafeInteger(value) || value < 0)
    .map(([key, value]) => `usage.${key} is ${String(value)}`);
  if (
    problems.length === 0 &&
    usage.totalTokens < usage.promptTokens + usage.completionTokens
  ) {
    problems.push("usage.totalTokens is below prompt + completion");
  }
  return problems;
};

/** Orders tool calls by their input's JSON, a key that is not language. */
const byInput = (
  left: { input: unknown },
  right: { input: unknown },
): number => {
  const leftKey = JSON.stringify(left.input);
  const rightKey = JSON.stringify(right.input);
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
};

const parsesAsJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** Every way `run` breaks the contract for `cassette`. */
export const findWireContractViolations = ({
  cassette,
  replay,
  run,
}: {
  cassette: ProviderWireCassette;
  replay: ProviderWireReplayFindings;
  run: WireRun;
}): OracleViolation[] => {
  const { chunks, thrown } = run;
  const expected = cassette.expect;
  const terminals = chunks.filter(({ type }) => TERMINAL_TYPES.has(type));
  const last = chunks.at(-1);
  const finished = chunks.find(isRunFinished);
  const failed = chunks.find(isRunError);

  const transport = [
    ...replay.unexpected.map((request) => ({ unexpected: request })),
    ...replay.unconsumed.map((exchange) => ({ unconsumed: exchange })),
  ];

  const oneTerminal = [
    ...(terminals.length === 1
      ? []
      : [{ terminalEvents: terminals.map(({ type }) => type) }]),
    ...(last !== undefined && TERMINAL_TYPES.has(last.type)
      ? []
      : [{ lastEvent: last?.type ?? null }]),
    ...(thrown === undefined ? [] : [{ thrown: Bun.inspect(thrown) }]),
    ...(run.overdue === true
      ? [{ problem: "no terminal event before the deadline" }]
      : []),
  ];

  const outcome: unknown[] = [];
  const text: unknown[] = [];
  const toolInput: unknown[] = [];
  const usage: unknown[] = [];
  const errors: unknown[] = [];
  const calls = toolCallsOf(chunks);
  for (const call of calls) {
    if (!call.ended) {
      toolInput.push({ call: call.id, problem: "never ended" });
    }
    if (call.argumentDeltas !== "" && !parsesAsJson(call.argumentDeltas)) {
      toolInput.push({
        call: call.id,
        problem: "streamed arguments are not JSON",
      });
    }
  }
  // Counted on the events: the summaries above are keyed by id already.
  for (const type of [EventType.TOOL_CALL_START, EventType.TOOL_CALL_END]) {
    const ids = chunks.flatMap((chunk) =>
      chunk.type === type && "toolCallId" in chunk ? [chunk.toolCallId] : [],
    );
    if (new Set(ids).size !== ids.length) {
      toolInput.push({ event: type, problem: "a tool call id repeats" });
    }
  }

  if (expected.outcome === "finished") {
    if (finished === undefined) {
      outcome.push({ expected: "RUN_FINISHED", got: failed?.message ?? null });
    } else {
      const finishReason = finished.finishReason;
      if (!DECLARED_FINISH_REASONS.has(finishReason)) {
        outcome.push({ undeclaredFinishReason: finishReason ?? null });
      }
      if (finishReason !== expected.finishReason) {
        outcome.push({
          expected: expected.finishReason,
          got: finishReason ?? null,
        });
      }
      // An adapter reports usage normalized; the AG-UI spec array is the
      // engine's outbound form, not an adapter's.
      const reported = Array.isArray(finished.usage)
        ? undefined
        : finished.usage;
      if (Array.isArray(finished.usage)) {
        usage.push("the finished run reports usage in the spec array form");
      } else {
        usage.push(...usageProblems(reported));
      }
      if (
        expected.usage !== undefined &&
        reported !== undefined &&
        (reported.promptTokens !== expected.usage.promptTokens ||
          reported.completionTokens !== expected.usage.completionTokens ||
          reported.totalTokens !== expected.usage.totalTokens)
      ) {
        usage.push({ expected: expected.usage, got: reported });
      }
    }
    const streamedText = textOf(chunks);
    const expectsText = (expected.toolCalls ?? []).length === 0;
    if (expected.text !== undefined && streamedText !== expected.text) {
      text.push({ expected: expected.text, got: streamedText });
    }
    if (
      expected.text === undefined &&
      expectsText &&
      streamedText.trim() === ""
    ) {
      text.push({ expected: "non-empty text", got: streamedText });
    }
    // Parallel calls may arrive in either order.
    const expectedCalls = (expected.toolCalls ?? []).toSorted(byInput);
    const sortedCalls = calls.toSorted(byInput);
    if (sortedCalls.length !== expectedCalls.length) {
      toolInput.push({
        expectedCalls: expectedCalls.length,
        got: sortedCalls.map(({ input, name }) => ({ input, name })),
      });
    }
    for (const [index, call] of sortedCalls.entries()) {
      const parsed = v.safeParse(WIRE_TOOL_INPUT, call.input);
      if (!parsed.success) {
        toolInput.push({
          call: call.id,
          input: call.input,
          problem: "input does not satisfy the declared schema",
        });
      }
      const want = expectedCalls[index];
      if (
        want !== undefined &&
        (call.name !== want.name ||
          JSON.stringify(call.input) !== JSON.stringify(want.input))
      ) {
        toolInput.push({
          expected: want,
          got: { input: call.input, name: call.name },
        });
      }
    }
  } else if (failed === undefined) {
    outcome.push({
      expected: "RUN_ERROR",
      got: finished?.finishReason ?? null,
      text: textOf(chunks),
    });
  } else {
    if (failed.message.trim() === "") {
      errors.push({ problem: "the run error carries no message" });
    }
    const kind = classifyRunErrorChunk(failed);
    if (kind !== expected.errorKind) {
      errors.push({ expected: expected.errorKind, got: kind });
    }
  }

  return [
    ...violationsOf(CHAT_ORACLE.providerWireTransport, transport),
    ...violationsOf(CHAT_ORACLE.providerWireOneTerminal, oneTerminal),
    ...violationsOf(CHAT_ORACLE.providerWireFinish, outcome),
    ...violationsOf(CHAT_ORACLE.providerWireText, text),
    ...violationsOf(CHAT_ORACLE.providerWireToolInput, toolInput),
    ...violationsOf(CHAT_ORACLE.providerWireUsage, usage),
    ...violationsOf(CHAT_ORACLE.providerWireError, errors),
  ];
};

/**
 * A run cancelled mid-stream ends promptly, reads as neither a finished
 * answer nor a crash, and asks the provider nothing more.
 */
export const findWireCancelViolations = ({
  replay,
  requests,
  run,
}: {
  replay: ProviderWireReplayFindings;
  requests: number;
  run: WireRun;
}): OracleViolation[] => {
  const terminals = run.chunks.filter(({ type }) => TERMINAL_TYPES.has(type));
  const findings: unknown[] = [];
  if (run.cancelSettledMs === null) {
    findings.push({
      problem: "the run produced no text delta to cancel after",
    });
  } else if (!Number.isFinite(run.cancelSettledMs)) {
    findings.push({ problem: "the run did not end after the cancel" });
  } else if (run.cancelSettledMs > CANCEL_SETTLE_MS) {
    findings.push({ settledMs: Math.round(run.cancelSettledMs) });
  }
  if (run.chunks.some(isRunFinished)) {
    findings.push({ problem: "a cancelled run reads as finished" });
  }
  if (terminals.length > 1) {
    findings.push({ terminalEvents: terminals.map(({ type }) => type) });
  }
  if (requests !== 1) {
    findings.push({ requests });
  }
  return [
    ...violationsOf(CHAT_ORACLE.providerWireCancel, findings),
    ...violationsOf(
      CHAT_ORACLE.providerWireTransport,
      replay.unexpected.map((request) => ({ unexpected: request })),
    ),
  ];
};

/** Serves `cassette` and runs its scenario against its provider's adapter. */
export const replayWireScenario = async ({
  cancelAfterFirstDelta,
  cassette,
  replay,
}: {
  cancelAfterFirstDelta?: boolean | undefined;
  cassette: ProviderWireCassette;
  replay: ProviderWireReplay;
}) => {
  replay.serve(
    cassette,
    cancelAfterFirstDelta === true
      ? { holdAfterBytes: holdPoint(cassette) }
      : {},
  );
  const request = {
    apiKey: "cassette-replay-no-credentials",
    model: cassette.model,
    provider: cassette.provider,
    scenario: cassette.scenario,
  };
  const run =
    cancelAfterFirstDelta === true
      ? await runCancelledWireScenario(request)
      : await runWireScenario(request);
  const requests = replay.requests().length;
  return { findings: replay.takeFindings(), requests, run };
};

/** Where a text cassette goes quiet for the cancel run: at the end of its
 *  first text-bearing event, before the rest. */
const holdPoint = (cassette: ProviderWireCassette): number => {
  const [first] = cassette.exchanges;
  if (first === undefined) {
    return 0;
  }
  const body = first.response.body;
  if (body.encoding === "aws-eventstream") {
    const index = body.messages.findIndex(
      ({ headers }) => headers[":event-type"] === "contentBlockDelta",
    );
    return body.messages
      .slice(0, index + 1)
      .reduce(
        (sum, message) => sum + encodeAwsEventStreamMessage(message).length,
        0,
      );
  }
  const text = body.text;
  const marker = text.indexOf("The");
  const separator =
    marker === -1 ? null : /\r?\n\r?\n/u.exec(text.slice(marker));
  const end =
    marker === -1 || separator === null
      ? text.length
      : marker + separator.index + separator[0].length;
  return new TextEncoder().encode(text.slice(0, end)).length;
};
