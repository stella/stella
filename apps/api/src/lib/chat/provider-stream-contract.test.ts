import { chat, EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyTextAdapter, ModelMessage, StreamChunk } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  INCOMPLETE_STREAM_CODE,
  withProviderStreamContract,
  withRunToolCallIds,
} from "@/api/lib/chat/provider-stream-contract";
import { reasoningProvenanceForSignature } from "@/api/lib/chat/reasoning-provenance";
import { ToolCallIdLedger } from "@/api/lib/chat/unique-tool-call-ids";
import { isRecord } from "@/api/lib/type-guards";
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
const failed: StreamChunk = {
  type: EventType.RUN_ERROR,
  message: "rate limited",
  timestamp: 1,
};
const finished: StreamChunk = {
  type: EventType.RUN_FINISHED,
  runId: "run",
  threadId: "thread",
  finishReason: "stop",
  timestamp: 1,
};

/** An adapter whose stream yields `chunks`, then throws when told to. */
const adapterOf = (
  chunks: readonly StreamChunk[],
  thenThrow = false,
): AnyTextAdapter =>
  asTestRaw<AnyTextAdapter>({
    kind: "text",
    model: "model",
    name: "fixture",
    label: () => "fixture",
    async *chatStream() {
      await Promise.resolve();
      yield* chunks;
      if (thenThrow) {
        panic("the provider connection dropped");
      }
    },
  });

const run = async (adapter: AnyTextAdapter, signal?: AbortSignal) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of withProviderStreamContract(adapter).chatStream({
    logger: resolveDebugOption(false),
    messages: [],
    model: "model",
    ...(signal === undefined ? {} : { request: { signal } }),
  })) {
    chunks.push(chunk);
  }
  return chunks.map((chunk) =>
    chunk.type === EventType.RUN_ERROR
      ? `${chunk.type}:${chunk.code ?? ""}`
      : chunk.type,
  );
};

describe("the provider stream contract", () => {
  test("a stream that stops before its terminal event ends in a run error", async () => {
    expect(await run(adapterOf([started, delta]))).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
      `RUN_ERROR:${INCOMPLETE_STREAM_CODE}`,
    ]);
  });

  test("a throw before the terminal event becomes the run error", async () => {
    expect(await run(adapterOf([started, delta], true))).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
      "RUN_ERROR:",
    ]);
  });

  test("nothing follows the terminal event, thrown or yielded", async () => {
    expect(await run(adapterOf([started, failed, finished], true))).toEqual([
      "RUN_STARTED",
      "RUN_ERROR:",
    ]);
  });

  test("a cancelled run ends where the cancel left it", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await run(adapterOf([started, delta]), controller.signal)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
    ]);
  });

  test("a reader that stops early closes the adapter's stream", async () => {
    let closed = false;
    const adapter = asTestRaw<AnyTextAdapter>({
      kind: "text",
      model: "model",
      name: "fixture",
      async *chatStream() {
        try {
          await Promise.resolve();
          yield started;
          yield delta;
          yield finished;
        } finally {
          closed = true;
        }
      },
    });
    for await (const chunk of withProviderStreamContract(adapter).chatStream({
      logger: resolveDebugOption(false),
      messages: [],
      model: "model",
    })) {
      if (chunk.type === EventType.RUN_STARTED) {
        break;
      }
    }
    expect(closed).toBe(true);
  });

  test("a run's call id ledger reaches the stream, never the request", async () => {
    const seen: unknown[] = [];
    const adapter = asTestRaw<AnyTextAdapter>({
      kind: "text",
      model: "model",
      name: "fixture",
      async *chatStream(options: unknown) {
        seen.push(options);
        await Promise.resolve();
        yield started;
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call_0",
          toolCallName: "search",
          toolName: "search",
          timestamp: 1,
        };
        yield finished;
      },
    });
    const request = {
      logger: resolveDebugOption(false),
      messages: [],
      model: "model",
    };
    const ids: string[] = [];
    for await (const chunk of withRunToolCallIds(
      withProviderStreamContract(adapter),
      new ToolCallIdLedger(["call_0"]),
    ).chatStream(request)) {
      if (chunk.type === EventType.TOOL_CALL_START) {
        ids.push(chunk.toolCallId);
      }
    }
    expect(ids).toEqual(["call_0_2"]);
    expect(seen).toHaveLength(1);
    expect(seen.at(0)).toBe(request);
  });

  test("an adapter is held to the contract once", () => {
    const contracted = withProviderStreamContract(adapterOf([]));
    expect(() => withProviderStreamContract(contracted)).toThrow(
      "already held to the provider stream contract",
    );
    expect(() =>
      withProviderStreamContract(
        withRunToolCallIds(contracted, new ToolCallIdLedger([])),
      ),
    ).toThrow("already held to the provider stream contract");
  });

  test("a run's ledger binds only to a contracted adapter", () => {
    expect(() =>
      withRunToolCallIds(adapterOf([]), new ToolCallIdLedger([])),
    ).toThrow("must be held to the provider stream contract");
  });

  test("every other member is the adapter's own", () => {
    const adapter = adapterOf([]);
    const contracted = withProviderStreamContract(adapter);
    expect(contracted.name).toBe("fixture");
    expect(contracted.model).toBe("model");
  });
});

// --- Reasoning across providers ----------------------------------------------

type ProviderFetch = typeof globalThis.fetch;

/** A `fetch` that answers every request with `answer` and records its body. */
const recordingFetch = (answer: () => Response) => {
  const bodies: unknown[] = [];
  const fetch: ProviderFetch = Object.assign(
    async (
      input: Parameters<ProviderFetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      bodies.push(await request.clone().json());
      return answer();
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return { bodies, fetch };
};

const eventStream = (
  events: readonly ({ type: string } & Record<string, unknown>)[],
) =>
  new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const refused = () =>
  new Response(
    JSON.stringify({
      error: { message: "stop", type: "invalid_request_error" },
      type: "error",
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

const REASONING = "The user asked for the draft.";

/** Anthropic's streamed answer with a signed thinking block. */
const anthropicReasoningAnswer = () =>
  eventStream([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: REASONING },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "EqQBCkgIBxABGAIqQJ4xY0b8" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Done." },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]);

/** OpenAI's streamed Responses answer with a reasoning item. */
const openAiReasoningAnswer = () => {
  const response = {
    id: "resp_1",
    object: "response",
    model: "gpt-5.2",
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "gAAAAABencrypted",
        summary: [{ type: "summary_text", text: REASONING }],
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done.", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  };
  return eventStream([
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.completed", response },
  ]);
};

const REASONING_PROVIDERS = ["anthropic", "openai"] as const;
type ReasoningProvider = (typeof REASONING_PROVIDERS)[number];

const reasoningAnswers = {
  anthropic: anthropicReasoningAnswer,
  openai: openAiReasoningAnswer,
} satisfies Record<ReasoningProvider, () => Response>;

/** What a provider's request shows of reasoning replayed to it. */
const replayedReasoning = {
  anthropic: '"type":"thinking"',
  openai: '"type":"reasoning"',
} satisfies Record<ReasoningProvider, string>;

const reasoningAdapter = (
  provider: ReasoningProvider,
  fetch: ProviderFetch,
): AnyTextAdapter =>
  withProviderStreamContract(
    provider === "anthropic"
      ? createAnthropicChat("claude-sonnet-4-6", "test-anthropic-key", {
          fetch,
        })
      : createOpenaiChat("gpt-5.2", "test-openai-key", { fetch }),
    provider,
  );

/** The signed reasoning `provider`'s adapter reads from its answer. */
const reasoningSignedBy = async (provider: ReasoningProvider) => {
  const { fetch } = recordingFetch(reasoningAnswers[provider]);
  const adapter = reasoningAdapter(provider, fetch);
  const signatures: string[] = [];
  for await (const chunk of adapter.chatStream({
    logger: resolveDebugOption(false),
    messages: [{ role: "user", content: "Delete the draft." }],
    model: adapter.model,
  })) {
    // The adapters carry a thinking step's signature on its finish.
    const signature: unknown =
      chunk.type === EventType.STEP_FINISHED
        ? Reflect.get(chunk, "signature")
        : undefined;
    if (typeof signature === "string" && signature !== "") {
      signatures.push(signature);
    }
  }
  expect(signatures).toHaveLength(1);
  const signature = signatures.join("");
  return {
    content: REASONING,
    signature,
    provenance: reasoningProvenanceForSignature({
      provider,
      modelId: adapter.model,
      signature,
    }),
  };
};

/** The body `provider`'s adapter sends for a thread holding `thinking`. */
const requestWithReasoning = async (
  provider: ReasoningProvider,
  thinking: { content: string; signature: string },
) => {
  const { bodies, fetch } = recordingFetch(refused);
  const adapter = reasoningAdapter(provider, fetch);
  for await (const _chunk of adapter.chatStream({
    logger: resolveDebugOption(false),
    messages: [
      { role: "user", content: "Delete the draft." },
      { role: "assistant", content: "Done.", thinking: [thinking] },
      { role: "user", content: "Thanks." },
    ],
    model: adapter.model,
  })) {
    // The refusal ends the stream once the request is written.
  }
  expect(bodies).toHaveLength(1);
  return JSON.stringify(bodies.at(0));
};

describe("signed reasoning in a thread's history", () => {
  for (const origin of REASONING_PROVIDERS) {
    for (const target of REASONING_PROVIDERS) {
      const kept = origin === target;
      test(`${origin} reasoning is ${kept ? "sent back to" : "left out of"} the ${target} request`, async () => {
        const body = await requestWithReasoning(
          target,
          await reasoningSignedBy(origin),
        );
        if (kept) {
          expect(body).toContain(replayedReasoning[target]);
        } else {
          expect(body).not.toContain(replayedReasoning[target]);
          expect(body).not.toContain(REASONING);
        }
      });
    }
  }
});

for (const boundary of ["base contract", "run tool-call ledger"] as const) {
  test(`the SDK tool loop replays current Anthropic thinking unchanged with one result through the ${boundary}`, async () => {
    const sink: ModelMessage[][] = [];
    const model = "claude-sonnet-4-6";
    const signature = "current-turn-signature";
    const raw: AnyTextAdapter = {
      ...adapterOf([]),
      model,
      async *chatStream({ messages, runId, threadId }) {
        sink.push(structuredClone(messages));
        yield {
          ...started,
          runId: runId ?? "run",
          threadId: threadId ?? "thread",
          model,
        };
        if (sink.length === 1) {
          yield {
            type: EventType.STEP_STARTED,
            stepName: "thinking",
            stepId: "step-1",
            model,
            timestamp: 1,
          };
          yield {
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: "thinking-1",
            delta: "Original thinking",
            model,
            timestamp: 1,
          };
          yield {
            type: EventType.STEP_FINISHED,
            stepName: "thinking",
            stepId: "step-1",
            signature,
            model,
            timestamp: 1,
          };
          yield {
            type: EventType.TOOL_CALL_START,
            toolCallId: "call-1",
            toolCallName: "search",
            model,
            timestamp: 1,
          };
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "call-1",
            delta: "{}",
            model,
            timestamp: 1,
          };
          yield {
            type: "TOOL_CALL_END",
            toolCallId: "call-1",
            input: {},
            model,
            timestamp: 1,
          };
          yield { ...finished, model, finishReason: "tool_calls" };
          return;
        }
        yield { ...delta, delta: "Answer", model };
        yield { ...finished, model };
      },
    };
    const baseContract = withProviderStreamContract(raw, "anthropic");
    const adapter =
      boundary === "base contract"
        ? baseContract
        : withRunToolCallIds(baseContract, new ToolCallIdLedger([]));
    const search = toolDefinition({
      name: "search",
      description: "Search",
      inputSchema: toTanStackToolSchema(v.object({})),
    }).server(async () => ({ found: true }));
    for await (const _chunk of chat({
      adapter,
      messages: [{ role: "user", content: "Search" }],
      tools: [search],
      agentLoopStrategy: maxIterations(3),
    })) {
      // Drain the SDK's real conversion and tool-execution loop.
    }
    expect(sink).toHaveLength(2);
    const continuation = sink.at(1) ?? [];
    expect<unknown>(
      continuation.flatMap((message) => message.thinking ?? []),
    ).toEqual([
      {
        content: "Original thinking",
        signature,
        provenance: {
          provider: "anthropic",
          model,
          format: "anthropic-thinking-signature",
        },
      },
    ]);
    const calls = continuation.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map(({ id }) => id)).toEqual(["call-1"]);
    expect(
      continuation
        .filter((message) => message.role === "tool")
        .map(({ toolCallId }) => toolCallId),
    ).toEqual(["call-1"]);
  });
}

describe("a resumed tool-use turn whose reasoning cannot be replayed", () => {
  const openCall = {
    id: "call-1",
    type: "function",
    function: { name: "delete", arguments: "{}" },
  } as const;

  /** The body `provider` sends to continue a tool-use turn holding `thinking`. */
  const continuationBody = async (
    provider: ReasoningProvider,
    thinking: ModelMessage["thinking"],
    modelOptions: Record<string, unknown>,
  ) => {
    const { bodies, fetch } = recordingFetch(refused);
    const adapter = reasoningAdapter(provider, fetch);
    for await (const _chunk of adapter.chatStream({
      logger: resolveDebugOption(false),
      messages: [
        { role: "user", content: "Delete the draft." },
        {
          role: "assistant",
          content: null,
          toolCalls: [openCall],
          ...(thinking === undefined ? {} : { thinking }),
        },
        {
          role: "tool",
          toolCallId: openCall.id,
          content: JSON.stringify({ status: "completed" }),
        },
      ],
      model: adapter.model,
      modelOptions,
    })) {
      // The refusal ends the stream once the request is written.
    }
    expect(bodies).toHaveLength(1);
    const body: unknown = bodies.at(0);
    return isRecord(body) ? body : panic("The request body is not an object");
  };

  /** Each Anthropic content block as role, type and the call it names. */
  const anthropicBlocks = (body: Record<string, unknown>) => {
    const messages = body["messages"];
    return (Array.isArray(messages) ? messages : []).flatMap(
      (message: unknown) => {
        if (!isRecord(message) || !Array.isArray(message["content"])) {
          return [];
        }
        const role = message["role"];
        return message["content"].flatMap((block: unknown) =>
          isRecord(block)
            ? [
                {
                  role,
                  type: block["type"],
                  call: block["id"] ?? block["tool_use_id"],
                },
              ]
            : [],
        );
      },
    );
  };

  test("Anthropic continues it with thinking disabled for that request and the call still answered", async () => {
    // Stored before reasoning carried provenance: it cannot be replayed.
    const body = await continuationBody(
      "anthropic",
      [{ content: REASONING, signature: "stored-signature" }],
      { thinking: { type: "adaptive" } },
    );
    expect(body["thinking"]).toEqual({ type: "disabled" });
    const blocks = anthropicBlocks(body);
    expect(blocks.filter(({ type }) => type === "thinking")).toEqual([]);
    const use = blocks.findIndex(({ type }) => type === "tool_use");
    const result = blocks.findIndex(({ type }) => type === "tool_result");
    expect(blocks.at(use)).toEqual({
      role: "assistant",
      type: "tool_use",
      call: openCall.id,
    });
    expect(blocks.at(result)).toEqual({
      role: "user",
      type: "tool_result",
      call: openCall.id,
    });
    expect(result).toBeGreaterThan(use);
  });

  test("OpenAI continues it with its reasoning options unchanged", async () => {
    const body = await continuationBody(
      "openai",
      [{ content: REASONING, signature: "stored-signature" }],
      { reasoning: { effort: "medium" } },
    );
    expect(body["reasoning"]).toMatchObject({ effort: "medium" });
    expect(body["thinking"]).toBeUndefined();
  });

  test("Anthropic keeps thinking when the turn's own reasoning is replayed", async () => {
    const thinking = await reasoningSignedBy("anthropic");
    const body = await continuationBody("anthropic", [thinking], {
      thinking: { type: "adaptive" },
    });
    expect(body["thinking"]).toEqual({ type: "adaptive" });
    expect(
      anthropicBlocks(body).filter(({ type }) => type === "thinking"),
    ).toHaveLength(1);
  });
});
