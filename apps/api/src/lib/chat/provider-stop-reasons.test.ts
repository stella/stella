import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";

import { classifyRunErrorChunk } from "@/api/handlers/chat/stream-chat";
import {
  PROVIDER_STOP_REASONS,
  PROVIDER_STOPPED_CODE,
  withDecidedStopReasons,
} from "@/api/lib/chat/provider-stop-reasons";
import type { StopOutcome } from "@/api/lib/chat/provider-stop-reasons";
import { INCOMPLETE_STREAM_CODE } from "@/api/lib/chat/provider-stream-contract";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";

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

const decide = async (
  provider: TanStackAIProvider,
  chunks: readonly StreamChunk[],
): Promise<StreamChunk[]> => {
  const out: StreamChunk[] = [];
  const source = async function* () {
    await Promise.resolve();
    yield* chunks;
  };
  for await (const chunk of withDecidedStopReasons(source(), {
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
} as const satisfies Record<StopOutcome, string>;

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

  test("the SDK does not know fails the run, on every provider", async () => {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      const chunks = await decide(provider, [
        started,
        delta,
        finishedWith("A_REASON_NO_SDK_KNOWS"),
      ]);
      expect(endingOf(chunks)).toBe("error:unknown");
      expect(chunks.at(-1)).toMatchObject({ code: PROVIDER_STOPPED_CODE });
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
