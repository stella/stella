import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import {
  codeExecutionTool,
  webFetchTool,
  webSearchTool,
} from "@tanstack/ai-anthropic/tools";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";

import { classifyRunErrorChunk } from "@/api/handlers/chat/stream-chat";
import {
  PROVIDER_STOP_REASONS,
  PROVIDER_STOPPED_CODE,
  refuseTurnPausingRequest,
  UNRECOGNIZED_STOP_REASON,
  withDecidedStopReasons,
} from "@/api/lib/chat/provider-stop-reasons";
import type { StopOutcome } from "@/api/lib/chat/provider-stop-reasons";
import {
  INCOMPLETE_STREAM_CODE,
  withProviderStreamContract,
} from "@/api/lib/chat/provider-stream-contract";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const started: StreamChunk = {
  type: EventType.RUN_STARTED,
  runId: "run",
  threadId: "thread",
  timestamp: 1,
};
const delta: StreamChunk = {
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "message",
  delta: "The cass",
  timestamp: 1,
};
const toolCall: StreamChunk = {
  type: EventType.TOOL_CALL_START,
  toolCallId: "call",
  toolCallName: "mcp__external__delete",
  toolName: "mcp__external__delete",
  timestamp: 1,
};
const usage = { completionTokens: 3, promptTokens: 31, totalTokens: 34 };

/** The adapter's own finish, carrying the provider's stop reason. */
const finishedWith = (
  reason: string | null,
  extra: Record<string, unknown> = {},
): StreamChunk => ({
  type: EventType.RUN_FINISHED,
  runId: "run",
  threadId: "thread",
  finishReason: "stop",
  timestamp: 1,
  usage,
  metadata: { providerStopReason: reason, ...extra },
});

/**
 * `chunks` as an adapter streams them.
 *
 * @yields Each of `chunks`, in order.
 */
const streamOf = async function* (chunks: readonly StreamChunk[]) {
  await Promise.resolve();
  yield* chunks;
};

const decide = async (
  provider: TanStackAIProvider,
  chunks: readonly StreamChunk[],
): Promise<StreamChunk[]> => {
  const out: StreamChunk[] = [];
  for await (const chunk of withDecidedStopReasons(streamOf(chunks), {
    provider,
    unfinishedCode: INCOMPLETE_STREAM_CODE,
  })) {
    out.push(chunk);
  }
  return out;
};

/** How a run's terminal event reads to the rest of the service. */
const endingOf = (chunks: readonly StreamChunk[]): string => {
  const last = chunks.at(-1);
  if (last?.type === EventType.RUN_FINISHED) {
    return `finished:${last.finishReason ?? "none"}`;
  }
  if (last?.type === EventType.RUN_ERROR) {
    return `error:${classifyRunErrorChunk(last)}`;
  }
  return `open:${last?.type ?? "none"}`;
};

/** How each outcome must read once decided, for a run that wrote text. */
const EXPECTED_ENDING = {
  ended: "finished:stop",
  length: "finished:length",
  content_filter: "finished:content_filter",
  unfinished: "error:provider_stream_incomplete",
  failed: "error:unknown",
  unrecognized: "finished:stop",
} as const satisfies Record<StopOutcome, string>;

/** A reason no provider's table lists. */
const UNLISTED = "A_REASON_NO_SDK_KNOWS";

const reasoning: StreamChunk = {
  type: EventType.REASONING_MESSAGE_CONTENT,
  messageId: "reasoning",
  delta: "Reading the clause first.",
  timestamp: 1,
};
const blankDelta: StreamChunk = { ...delta, delta: " \n" };
const toolCallChunk: StreamChunk = {
  type: EventType.TOOL_CALL_CHUNK,
  toolCallId: "call",
  toolCallName: "mcp__external__delete",
  delta: '{"name":"draft"}',
  timestamp: 1,
};

/** Each step shape, and whether an unlisted stop ending it finishes. */
const UNLISTED_STEPS = {
  "wrote text": { chunks: [started, delta], ending: "finished:stop" },
  "wrote reasoning": { chunks: [started, reasoning], ending: "finished:stop" },
  "wrote nothing": { chunks: [started], ending: "error:unknown" },
  "wrote only whitespace": {
    chunks: [started, blankDelta],
    ending: "error:unknown",
  },
  "wrote text and called a tool": {
    chunks: [started, delta, toolCall],
    ending: "error:unknown",
  },
  "wrote text and called a tool in the shorthand shape": {
    chunks: [started, delta, toolCallChunk],
    ending: "error:unknown",
  },
} as const satisfies Record<
  string,
  { chunks: readonly StreamChunk[]; ending: string }
>;

describe("a provider stop reason", () => {
  test("reads as a finished answer only when the model ended its turn", async () => {
    const endings: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const [reason, outcome] of Object.entries(
        PROVIDER_STOP_REASONS[provider],
      )) {
        const key = `${provider}/${reason}`;
        endings[key] = endingOf(
          await decide(provider, [started, delta, finishedWith(reason)]),
        );
        expected[key] = EXPECTED_ENDING[outcome];
      }
    }
    expect(endings).toEqual(expected);
  });

  test("a Google continuation leaves a partial answer unfinished", async () => {
    for (const chunks of [
      [started],
      [started, delta],
      [started, delta, toolCall],
    ]) {
      expect(
        endingOf(
          await decide("google", [...chunks, finishedWith("CONTINUATION")]),
        ),
      ).toBe("error:provider_stream_incomplete");
    }
  });

  test("that never arrived leaves the answer unfinished", async () => {
    // The adapters now fail most such streams themselves; this is the
    // decision for one that still finishes without a reason.
    for (const provider of TANSTACK_AI_PROVIDERS) {
      expect(
        endingOf(await decide(provider, [started, delta, finishedWith(null)])),
        JSON.stringify({ oracle: CHAT_ORACLE.providerWireFinish, provider }),
      ).toBe("error:provider_stream_incomplete");
    }
  });

  test("that ends the turn reads as tool_calls when the model called a tool", async () => {
    expect(
      endingOf(
        await decide("google", [started, toolCall, finishedWith("STOP")]),
      ),
    ).toBe("finished:tool_calls");
    // A tool-use stop with no call streamed has nothing to run.
    expect(
      endingOf(
        await decide("anthropic", [started, delta, finishedWith("tool_use")]),
      ),
    ).toBe("finished:stop");
  });

  test("keeps the adapter's detail on a failure it already reported", async () => {
    const reported: StreamChunk = {
      type: EventType.RUN_ERROR,
      message: "The model failed.",
      code: "server_error",
      timestamp: 1,
      error: { message: "The model failed.", code: "server_error" },
      metadata: { providerStopReason: "failed" },
    };
    expect(await decide("openai", [started, reported])).toEqual([
      started,
      {
        type: EventType.RUN_ERROR,
        message: "The model failed.",
        code: "server_error",
        timestamp: 1,
        error: { message: "The model failed.", code: "server_error" },
      },
    ]);
  });

  test("turns a ceiling stop the adapter reported as an error into a length finish", async () => {
    const ceiling: StreamChunk = {
      type: EventType.RUN_ERROR,
      message: "The response was cut off.",
      code: "max_tokens",
      timestamp: 1,
      usage,
      metadata: { providerStopReason: "max_tokens" },
    };
    expect(await decide("anthropic", [started, delta, ceiling])).toEqual([
      started,
      delta,
      {
        type: EventType.RUN_FINISHED,
        runId: "run",
        threadId: "thread",
        finishReason: "length",
        timestamp: 1,
        usage,
      },
    ]);
  });

  test("is read and removed, and the rest of the event passes on", async () => {
    const chunks = await decide("anthropic", [
      started,
      delta,
      finishedWith("refusal", { trace: "kept" }),
    ]);
    expect(chunks.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      runId: "run",
      threadId: "thread",
      finishReason: "content_filter",
      timestamp: 1,
      usage,
      metadata: { trace: "kept" },
    });
  });

  test("an event that carries none passes through unchanged", async () => {
    const finished: StreamChunk = {
      type: EventType.RUN_FINISHED,
      runId: "run",
      threadId: "thread",
      finishReason: "stop",
      timestamp: 1,
    };
    const chunks = await decide("mistral", [started, delta, finished]);
    expect(chunks.at(-1)).toBe(finished);
  });
});

describe("a stop reason no table lists", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;
  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });
  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  test("finishes a step that wrote an answer and called no tool, else fails it, on every provider", async () => {
    const endings: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const [step, { chunks, ending }] of Object.entries(UNLISTED_STEPS)) {
        const key = `${provider}/${step}`;
        endings[key] = endingOf(
          await decide(provider, [...chunks, finishedWith(UNLISTED)]),
        );
        expected[key] = ending;
      }
    }
    expect(
      endings,
      JSON.stringify({ oracle: CHAT_ORACLE.providerWireFinish }),
    ).toEqual(expected);
  });

  test("records its reason as unknown, keeping the provider's value out of the run", async () => {
    const chunks = await decide("anthropic", [
      started,
      delta,
      finishedWith(UNLISTED, { trace: "kept" }),
    ]);
    expect(chunks.at(-1)).toEqual({
      type: EventType.RUN_FINISHED,
      runId: "run",
      threadId: "thread",
      finishReason: "stop",
      timestamp: 1,
      usage,
      metadata: { trace: "kept", stopReason: UNRECOGNIZED_STOP_REASON },
    });
  });

  test("fails a step without an answer with no trace of the provider's value", async () => {
    const chunks = await decide("google", [started, finishedWith(UNLISTED)]);
    expect(chunks.at(-1)).toMatchObject({ code: PROVIDER_STOPPED_CODE });
    expect(JSON.stringify(chunks.at(-1))).not.toContain(UNLISTED);
  });

  test("keeps a failure the adapter reported, answer or not", async () => {
    const reported: StreamChunk = {
      type: EventType.RUN_ERROR,
      message: "The response is incomplete.",
      code: "incomplete",
      timestamp: 1,
      error: { message: "The response is incomplete.", code: "incomplete" },
      metadata: { providerStopReason: UNLISTED },
    };
    const kept: StreamChunk = {
      type: EventType.RUN_ERROR,
      message: "The response is incomplete.",
      code: "incomplete",
      timestamp: 1,
      error: { message: "The response is incomplete.", code: "incomplete" },
    };
    expect(
      await decide("openai", [started, delta, reported]),
      JSON.stringify({ oracle: CHAT_ORACLE.providerWireFinish }),
    ).toEqual([started, delta, kept]);
    expect(await decide("openai", [started, reported])).toEqual([
      started,
      kept,
    ]);
  });

  const REPORTED_RUNS = {
    finishes: { provider: "mistral", chunks: [started, delta] },
    fails: { provider: "bedrock", chunks: [started] },
  } as const satisfies Record<
    string,
    { provider: TanStackAIProvider; chunks: readonly StreamChunk[] }
  >;

  const expectReported = async (
    provider: TanStackAIProvider,
    chunks: readonly StreamChunk[],
  ) => {
    await decide(provider, [...chunks, finishedWith(UNLISTED)]);
    const reported = analytics
      .exceptions()
      .map(({ properties }) => properties)
      .filter(
        (properties) =>
          properties["error.class"] === "UnrecognizedProviderStopReasonError",
      );
    expect(reported.map((properties) => properties["source"])).toEqual([
      provider,
    ]);
    expect(JSON.stringify(reported)).not.toContain(UNLISTED);
    expect(
      logs
        .at("WARN")
        .filter(
          ({ message }) => message === "chat.provider_stop_reason_unrecognized",
        )
        .map(({ attributes }) => attributes),
    ).toEqual([
      expect.objectContaining({ provider, providerStopReason: UNLISTED }),
    ]);
  };

  for (const [ending, { provider, chunks }] of Object.entries(REPORTED_RUNS)) {
    test(`is reported when the run ${ending}, its value in the log only`, async () => {
      await expectReported(provider, chunks);
    });
  }

  test("a listed reason is not reported", async () => {
    await decide("anthropic", [started, delta, finishedWith("end_turn")]);
    expect(analytics.exceptions()).toEqual([]);
  });
});

// `pause_turn` and `compaction` stay unfinished until a paused turn can be
// sent again to continue it. Until then a request that can produce them
// fails before it is sent: these are the switches that enable them.
describe("an Anthropic request whose turn could pause", () => {
  type Request = Parameters<AnyTextAdapter["chatStream"]>[0];
  const request = (overrides: Partial<Request>): Request => ({
    logger: resolveDebugOption(false),
    messages: [],
    model: "model",
    ...overrides,
  });
  const PAUSING: Record<string, Partial<Request>> = {
    "web search": {
      tools: [
        webSearchTool({ name: "web_search", type: "web_search_20250305" }),
      ],
    },
    "web fetch": { tools: [webFetchTool()] },
    "code execution": {
      tools: [
        codeExecutionTool({
          name: "code_execution",
          type: "code_execution_20250825",
        }),
      ],
    },
    compaction: {
      modelOptions: {
        context_management: { edits: [{ type: "compact_20260112" }] },
      },
    },
  };

  for (const [name, overrides] of Object.entries(PAUSING)) {
    test(`is refused when it enables ${name}`, () => {
      expect(() => {
        refuseTurnPausingRequest("anthropic", request(overrides));
      }).toThrow(/pause_turn or compaction/u);
    });
  }

  test("goes through with the service's own tools and edits that keep the turn going", () => {
    expect(() => {
      refuseTurnPausingRequest(
        "anthropic",
        request({
          tools: [{ name: "mcp__external__delete", description: "Delete." }],
          modelOptions: {
            context_management: {
              edits: [{ type: "clear_tool_uses_20250919" }],
            },
          },
        }),
      );
    }).not.toThrow();
  });

  test("is refused by the stream contract before the adapter is called", () => {
    let called = false;
    const adapter = asTestRaw<AnyTextAdapter>({
      kind: "text",
      model: "model",
      name: "fixture",
      label: () => "fixture",
      chatStream: () => {
        called = true;
        return streamOf([]);
      },
    });
    expect(() =>
      withProviderStreamContract(adapter, "anthropic").chatStream(
        request(PAUSING["web search"] ?? {}),
      ),
    ).toThrow(/pause_turn or compaction/u);
    expect(called).toBe(false);
  });
});
