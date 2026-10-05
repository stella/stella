import {
  convertSchemaToJsonSchema,
  EventType,
  maxIterations,
  toolDefinition,
} from "@tanstack/ai";
import type { StreamChunk, TokenUsage } from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { BYOK_DEFAULT_MODELS, BYOK_MODEL_OPTIONS } from "@stll/ai-catalog";

import { chatAttemptRequestOptions } from "@/api/handlers/chat/chat-request";
import { classifyRunErrorChunk } from "@/api/handlers/chat/stream-chat";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { chatToolMapToArray } from "@/api/lib/chat/chat-tool-types";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { ToolCallIdLedger } from "@/api/lib/chat/unique-tool-call-ids";
import {
  clearByokAdapterCache,
  createTanStackTextAdapterFactory,
  getTanStackTextModelForRole,
} from "@/api/lib/tanstack-ai-models";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";
import {
  providerWireCassetteSchema,
  WIRE_TOOL_NAME,
} from "@/api/tests/helpers/provider-wire-cassette";
import type {
  ProviderWireCassette,
  ProviderWireProvider,
  ProviderWireRequestShape,
  ProviderWireScenario,
} from "@/api/tests/helpers/provider-wire-cassette";
import { encodeAwsEventStreamMessage } from "@/api/tests/helpers/provider-wire-replay";
import type {
  Chunking,
  ProviderWireReplay,
  ProviderWireReplayFindings,
  ReplayedRequest,
} from "@/api/tests/helpers/provider-wire-replay";

// One contract for every provider adapter. A run sends the fixed synthetic
// request for a scenario through the real adapter, as the chat engine would
// hand it over (production model options, the provider's tool projection,
// the engine's schema conversion), and collects the normalized events. The
// recorder sends the same request to the live provider, so a recording and
// its replay differ only in who answers.

/** The declared input of the wire tool: `note` is optional, so a strict
 *  provider widens it to `null` on the wire, and a route that fills every
 *  field sends ""; a note is never empty, so "" is not one. */
export const WIRE_TOOL_INPUT = v.object({
  name: v.string(),
  note: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export const wireTool = () =>
  toolDefinition({
    name: WIRE_TOOL_NAME,
    description: "Delete a draft by name.",
    inputSchema: toTanStackToolSchema(WIRE_TOOL_INPUT),
  });

export const EXPECTED_TEXT = "The cassette plays.";
const TEXT_PROMPT = `Reply with exactly this sentence and nothing else: ${EXPECTED_TEXT}`;

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
  "unusable-stop": TEXT_PROMPT,
  "unlisted-stop": TEXT_PROMPT,
} as const satisfies Record<ProviderWireScenario, string>;

/** A provider's own wording for a scenario, where the shared prompt records
 *  something else. */
const PROVIDER_SCENARIO_PROMPTS: Partial<
  Record<ProviderWireProvider, Partial<Record<ProviderWireScenario, string>>>
> = {
  // Bedrock's Claude fills the optional note unless told to leave it out.
  bedrock: {
    "tool-call": `Call the ${WIRE_TOOL_NAME} tool once with only name "draft", leaving note out. Do not write any text.`,
    "parallel-tool-calls": `Call the ${WIRE_TOOL_NAME} tool twice in parallel, in one response: once with name "draft" and once with name "memo", neither with a note. Do not write any text.`,
  },
};

/** The one user message a scenario sends to `provider`. */
export const scenarioPrompt = (
  provider: ProviderWireProvider,
  scenario: ProviderWireScenario,
): string =>
  PROVIDER_SCENARIO_PROMPTS[provider]?.[scenario] ?? SCENARIO_PROMPTS[scenario];

/** The output ceiling the length scenario asks for. */
const LENGTH_SCENARIO_MAX_TOKENS = 16;
/** A model id no provider serves, for the rejected request. */
export const UNKNOWN_MODEL_ID = "stella-cassette-no-such-model";

/** The chat model a provider's corpus is recorded with by default. */
export const wireChatModel = (provider: ProviderWireProvider): string =>
  BYOK_DEFAULT_MODELS[provider].chat;

/** A model of the provider's other than `chat`, for side calls such as
 *  thread titles. */
export const wireSideModel = (
  provider: ProviderWireProvider,
  chat: string,
): string => {
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
    {
      dataClass: "public_corpus",
      organizationId: null,
      modelTier: MANAGED_MODEL_TIER.standard,
    },
  );
  // The chat attempt's own request options, so each cassette pins the
  // request a chat turn sends (its system prompt aside: the scenarios send
  // only their prompt).
  const requestOptions = chatAttemptRequestOptions({
    caching: { enabled: false, reason: "org-disabled" },
    ...(scenario === "length"
      ? { maxOutputTokens: LENGTH_SCENARIO_MAX_TOKENS }
      : {}),
    model:
      resolved.modelId === model
        ? resolved
        : {
            ...resolved,
            adapter: createTanStackTextAdapterFactory({
              dataClass: "public_corpus",
              apiKey,
              provider,
            })(model),
          },
    modelTools: chatToolMapToArray({ [WIRE_TOOL_NAME]: wireTool() }),
    role: "chat",
    system: undefined,
    toolCallIds: new ToolCallIdLedger([]),
  });
  return {
    ...requestOptions,
    messages: [
      { role: "user" as const, content: scenarioPrompt(provider, scenario) },
    ],
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
  const { adapter, messages, tools, ...requestOptions } =
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
        // Everything else the chat attempt sets, as it sets it.
        ...requestOptions,
        logger: resolveDebugOption(false),
        messages,
        model: options.model,
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
  const { adapter, messages, tools, ...requestOptions } =
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
        ...requestOptions,
        abortController,
        adapter,
        agentLoopStrategy: maxIterations(1),
        messages,
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
    return ["the run reports no usage"];
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

/**
 * A provider that reported usage before the run failed billed it: the run
 * error carries exactly that, and no usage the wire never reported.
 */
const runErrorUsageProblems = (
  expected: ProviderWireCassette["expect"]["usage"],
  failed: RunError,
): unknown[] => {
  if (Array.isArray(failed.usage)) {
    return ["the run error reports usage in the spec array form"];
  }
  if (expected === undefined) {
    return failed.usage === undefined
      ? []
      : [{ expected: null, got: failed.usage }];
  }
  const problems: unknown[] = usageProblems(failed.usage);
  if (
    failed.usage !== undefined &&
    (failed.usage.promptTokens !== expected.promptTokens ||
      failed.usage.completionTokens !== expected.completionTokens ||
      failed.usage.totalTokens !== expected.totalTokens)
  ) {
    problems.push({ expected, got: failed.usage });
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
    // A reply cut off at the output ceiling may have spent the whole budget
    // before writing any text (a reasoning model); every other answer that
    // calls no tool has text.
    const expectsText =
      (expected.toolCalls ?? []).length === 0 &&
      expected.finishReason !== "length";
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
    usage.push(...runErrorUsageProblems(expected.usage, failed));
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

// --- The request shape ------------------------------------------------------

/** Request headers that change what a provider does with a request. The rest
 *  (credentials, SDK versions, retry counters, invocation ids) stay out of a
 *  request's shape. */
const PINNED_REQUEST_HEADERS = [
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
] as const;

const PROMPT_PLACEHOLDER = "[prompt]";

const withPromptReplaced = (value: unknown, prompt: string): unknown => {
  if (value === prompt) {
    return PROMPT_PLACEHOLDER;
  }
  if (Array.isArray(value)) {
    return value.map((child) => withPromptReplaced(child, prompt));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        withPromptReplaced(child, prompt),
      ]),
    );
  }
  return value;
};

/** The shape of one request that sent `prompt`. */
export const wireRequestShape = ({
  body,
  headers,
  prompt,
}: {
  body: string;
  headers: Headers;
  prompt: string;
}): ProviderWireRequestShape => {
  const parsed = Result.try((): unknown => JSON.parse(body));
  return {
    headers: Object.fromEntries(
      PINNED_REQUEST_HEADERS.flatMap((name) => {
        const value = headers.get(name);
        return value === null ? [] : [[name, value]];
      }),
    ),
    body: Result.isOk(parsed)
      ? withPromptReplaced(parsed.value, prompt)
      : body.replaceAll(prompt, () => PROMPT_PLACEHOLDER),
  };
};

/** The prompt a cassette's requests send. */
export const cassettePrompt = (cassette: ProviderWireCassette): string =>
  cassette.prompt ?? scenarioPrompt(cassette.provider, cassette.scenario);

/** A shape as it is compared and shown: headers by name, the body in the
 *  order it was written, since a strict provider generates a tool's input
 *  in its schema's property order. */
const requestShapeText = (shape: ProviderWireRequestShape): string =>
  JSON.stringify(
    {
      headers: Object.fromEntries(
        // Header names are ASCII and unique.
        Object.entries(shape.headers).toSorted(([left], [right]) =>
          left < right ? -1 : 1,
        ),
      ),
      body: shape.body,
    },
    null,
    2,
  );

export type RequestShapeDrift = {
  exchange: number;
  expected: string;
  got: string;
};

/** Every answered request whose shape is not the one its exchange pins. A
 *  refused or side request is the transport oracle's finding. */
export const findRequestShapeDrift = ({
  cassette,
  sent,
}: {
  cassette: ProviderWireCassette;
  sent: readonly ReplayedRequest[];
}): RequestShapeDrift[] => {
  const prompt = cassettePrompt(cassette);
  return sent.flatMap((request) => {
    if (typeof request.exchange !== "number") {
      return [];
    }
    const exchange =
      cassette.exchanges[request.exchange] ??
      panic(`No exchange ${String(request.exchange)} answered the request`);
    const pinned = exchange.request.shape;
    const expected =
      pinned === undefined ? "(no shape pinned)" : requestShapeText(pinned);
    const got = requestShapeText(wireRequestShape({ ...request, prompt }));
    return got === expected
      ? []
      : [{ exchange: request.exchange, expected, got }];
  });
};

/** Serves `cassette` and runs its scenario against its provider's adapter. */
export const replayWireScenario = async ({
  cancelAfterFirstDelta,
  cassette,
  chunking,
  recordedRetryResponses,
  replay,
}: {
  cancelAfterFirstDelta?: boolean | undefined;
  cassette: ProviderWireCassette;
  /** Where the bodies are cut into reads; the replay's default otherwise. */
  chunking?: Chunking | undefined;
  /** Keep these responses on the SDK's recorded backoff before the hint. */
  recordedRetryResponses?: number | undefined;
  replay: ProviderWireReplay;
}) => {
  replay.serve(cassette, {
    chunking,
    recordedRetryResponses,
    ...(cancelAfterFirstDelta === true
      ? { holdAfterBytes: holdPoint(cassette) }
      : {}),
  });
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
  const sent = [...replay.requests()];
  return {
    findings: replay.takeFindings(),
    requests: sent.length,
    run,
    sent,
    transcripts: replay.takeRequests(),
  };
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

// --- Reads split anywhere ---------------------------------------------------

/**
 * Words the split replay spells in multi-byte UTF-8 (two, three and four
 * bytes a character), in answer text and in tool arguments, so a one-byte
 * read lands inside each kind of character. Every text answer in the corpus
 * starts with "The"; the others reach the words a provider did not split
 * into separate deltas.
 */
const MULTIBYTE_SPELLINGS = [
  ["The", "Thé ✓ 🎞"],
  ["cassette", "kazetě"],
  ["draft", "návrh 📄"],
] as const;

const spelledMultibyte = (text: string): string => {
  let spelled = text;
  for (const [word, multibyte] of MULTIBYTE_SPELLINGS) {
    spelled = spelled.replaceAll(word, () => multibyte);
  }
  return spelled;
};

/** `cassette` with those words spelled in multi-byte characters wherever
 *  its bodies carry them. */
export const withMultibyteText = (
  cassette: ProviderWireCassette,
): ProviderWireCassette =>
  v.parse(
    providerWireCassetteSchema,
    JSON.parse(spelledMultibyte(JSON.stringify(cassette))),
  );

/** Event fields that carry an id an adapter generates per run. */
const isGeneratedIdField = (key: string): boolean =>
  key.endsWith("Id") || key === "stepName";

/** `run` as the split replay compares it: no timestamps, and each generated
 *  id replaced by its order of first appearance. */
const comparableRun = (run: WireRun) => {
  const ids = new Map<string, string>();
  const events = run.chunks.map((chunk): string =>
    JSON.stringify(chunk, (key, value: unknown) => {
      if (key === "timestamp") {
        return undefined;
      }
      if (isGeneratedIdField(key) && typeof value === "string") {
        const known = ids.get(value) ?? `id-${String(ids.size + 1)}`;
        ids.set(value, known);
        return known;
      }
      return value;
    }),
  );
  return {
    events,
    ending: {
      overdue: run.overdue === true,
      thrown: run.thrown === undefined ? null : Bun.inspect(run.thrown),
    },
  };
};

/**
 * Every way `split` (the run over bodies cut into reads by `chunking`)
 * differs from `whole` (the run over each body in one read): the first event
 * that differs, and how the run ended.
 */
export const findWireSplitViolations = ({
  chunking,
  split,
  whole,
}: {
  chunking: Chunking;
  split: WireRun;
  whole: WireRun;
}): OracleViolation[] => {
  const expected = comparableRun(whole);
  const got = comparableRun(split);
  const findings: unknown[] = [];
  const differs = Array.from(
    { length: Math.max(expected.events.length, got.events.length) },
    (_, index) => index,
  ).find((index) => expected.events[index] !== got.events[index]);
  if (differs !== undefined) {
    findings.push({
      chunking,
      event: differs,
      expected: expected.events[differs] ?? null,
      got: got.events[differs] ?? null,
    });
  }
  if (JSON.stringify(expected.ending) !== JSON.stringify(got.ending)) {
    findings.push({ chunking, expected: expected.ending, got: got.ending });
  }
  return violationsOf(CHAT_ORACLE.providerWireSplit, findings);
};
