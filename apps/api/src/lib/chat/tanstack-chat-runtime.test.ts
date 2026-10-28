import {
  DISCOVERY_TOOL_NAME,
  EventType,
  normalizeStreamChunk,
  toolDefinition,
} from "@tanstack/ai";
import type {
  AdapterYieldChunk,
  AnyTextAdapter,
  ModelMessage,
  StreamChunk,
  UIMessage,
} from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  isServerChatToolCall,
} from "@stll/api-contract/chat";
import { sleep } from "@stll/concurrency/sleep";
import { assertProperty } from "@stll/property-testing";

import {
  chatMessageFromPersisted,
  isChatPart,
  normalizePersistedChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { chatRefsWrittenIn } from "@/api/handlers/chat/chat-refs-shown";
import { normalizeStoredChatToolExecutor } from "@/api/handlers/chat/legacy-tool-compat";
import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import {
  finishReasonOf,
  streamChatChunks,
  STRIPPED_CHUNK_KEYS,
  toolCallEndInputOf,
  toolCallEndOutputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type {
  PublicChunkOfType,
  PublicRunFinishedChunk,
  PublicStreamChunk,
  PublicToolCallEndChunk,
  PublicToolCallStartChunk,
} from "@/api/lib/chat/tanstack-chat-runtime";
import {
  scriptedAdapterBase,
  scriptedTurnChunks,
} from "@/api/tests/helpers/chat-round-trip";

test("finishes an asynchronous document mutation before a sibling read starts", async () => {
  let documentVersion = 1;
  let observedVersion = 0;
  let iteration = 0;
  const adapter: AnyTextAdapter = {
    ...scriptedAdapterBase,
    async *chatStream({ model, runId, threadId }) {
      const index = iteration++;
      yield* scriptedTurnChunks(
        index === 0
          ? {
              type: "step",
              toolCalls: [
                {
                  toolCallId: "write",
                  toolName: "write_document",
                  arguments: "{}",
                },
                {
                  toolCallId: "read",
                  toolName: "read_document",
                  arguments: "{}",
                },
              ],
            }
          : { type: "step", text: "Document updated", toolCalls: [] },
        { index, model, runId: runId ?? "run", threadId: threadId ?? "thread" },
      );
    },
    structuredOutput: () => panic("No structured output in this test"),
  };
  const tools = [
    toolDefinition({
      name: "write_document",
      description: "Write the document",
    }).server(async () => {
      await sleep(0);
      documentVersion = 2;
      return { version: documentVersion };
    }),
    toolDefinition({
      name: "read_document",
      description: "Read the document",
    }).server(() => {
      observedVersion = documentVersion;
      return { version: observedVersion };
    }),
  ];
  const results: Extract<
    PublicStreamChunk,
    { type: EventType.TOOL_CALL_RESULT }
  >["content"][] = [];
  for await (const chunk of streamChatChunks({
    adapter,
    messages: [],
    tools,
  })) {
    if (chunk.type === EventType.TOOL_CALL_RESULT) {
      results.push(chunk.content);
    }
  }
  expect(iteration).toBe(2);
  expect(results).toHaveLength(2);
  expect(documentVersion).toBe(2);
  expect(observedVersion).toBe(documentVersion);
});

test("sequential gated and ungated calls execute in document order after approval", async () => {
  await assertProperty(
    "sequential gated and ungated calls execute in document order after approval",
    fc.asyncProperty(
      fc.array(fc.constantFrom("read_document", "write_document"), {
        maxLength: 2,
      }),
      fc.array(
        fc.constantFrom("read_document", "write_document", "approved_write"),
        {
          minLength: 1,
          maxLength: 6,
        },
      ),
      async (prefix, siblings) => {
        for (const approved of [true, false]) {
          // Every case reaches the gate before a dependent read and mutation.
          const names = [
            ...prefix,
            "approved_write",
            "read_document",
            "write_document",
            ...siblings,
          ];
          const calls = names.map((toolName, index) => ({
            toolCallId: `call-${index}`,
            toolName,
            arguments: "{}",
          }));
          const executed: string[] = [];
          const versions: number[] = [];
          let documentVersion = 0;
          let iteration = 0;
          const modelHistory: ModelMessage[][] = [];
          const adapter: AnyTextAdapter = {
            ...scriptedAdapterBase,
            async *chatStream({ messages, model, runId, threadId }) {
              modelHistory.push(messages);
              const index = iteration++;
              yield* scriptedTurnChunks(
                index === 0
                  ? { type: "step", toolCalls: calls }
                  : { type: "step", text: "Document updated", toolCalls: [] },
                {
                  index,
                  model,
                  runId: runId ?? "run",
                  threadId: threadId ?? "thread",
                },
              );
            },
            structuredOutput: () => panic("No structured output in this test"),
          };
          const tools = [
            toolDefinition({
              name: "approved_write",
              description: "Approved document write",
              needsApproval: true,
            }).server(async () => {
              await sleep(0);
              executed.push("approved_write");
              versions.push(++documentVersion);
              return { version: documentVersion };
            }),
            toolDefinition({
              name: "write_document",
              description: "Document write",
            }).server(async () => {
              await sleep(0);
              executed.push("write_document");
              versions.push(++documentVersion);
              return { version: documentVersion };
            }),
            toolDefinition({
              name: "read_document",
              description: "Document read",
            }).server(() => {
              executed.push("read_document");
              versions.push(documentVersion);
              return { version: documentVersion };
            }),
          ];
          const { processor } = createStreamMessageCapture({
            initialMessages: [],
            capture: (message) => message,
          });
          for await (const chunk of streamChatChunks({
            adapter,
            messages: [],
            tools,
          })) {
            processor.processChunk(chunk);
          }
          expect(iteration).toBe(1);
          expect(executed).toEqual(prefix);
          const deferredCalls = processor
            .getMessages()
            .flatMap(({ parts }) =>
              parts.filter(
                (part) =>
                  part.type === "tool-call" && part.state === "input-complete",
              ),
            );
          expect(deferredCalls.length).toBeGreaterThan(0);
          expect(
            deferredCalls.every((part) => isServerChatToolCall(part)),
          ).toBe(true);
          const pending = processor
            .getMessages()
            .flatMap(({ parts }) => parts)
            .filter(
              (part) =>
                part.type === "tool-call" && part.approval !== undefined,
            );
          expect(pending).toHaveLength(
            names.filter((name) => name === "approved_write").length,
          );
          for (const part of pending) {
            if (part.type !== "tool-call" || part.approval === undefined) {
              panic("Approval part lost its approval");
            }
            processor.addToolApprovalResponse(part.approval.id, approved);
          }
          for await (const chunk of streamChatChunks({
            adapter,
            messages: processor.getMessages(),
            tools,
          })) {
            processor.processChunk(chunk);
          }
          expect(iteration).toBe(2);
          const executableNames = names.filter(
            (name) => approved || name !== "approved_write",
          );
          expect(executed).toEqual(executableNames);
          let expectedVersion = 0;
          expect(versions).toEqual(
            executableNames.map((name) =>
              name === "read_document" ? expectedVersion : ++expectedVersion,
            ),
          );
          const settledCalls = processor
            .getMessages()
            .flatMap(({ parts }) => parts)
            .filter((part) => part.type === "tool-call");
          expect(settledCalls).toHaveLength(names.length);
          const settledResults = processor
            .getMessages()
            .flatMap(({ parts }) => parts)
            .filter((part) => part.type === "tool-result");
          expect(settledResults).toHaveLength(executableNames.length);
          for (const part of settledCalls) {
            const result = settledResults.find(
              ({ toolCallId }) => toolCallId === part.id,
            );
            if (!approved && part.name === "approved_write") {
              expect(part.approval?.approved).toBe(false);
              // The SDK inserts the denial into model history during UI
              // conversion; it does not emit that result on the raw stream.
              expect(result).toBeUndefined();
              expect(
                modelHistory
                  .at(-1)
                  ?.find(
                    (message) =>
                      message.role === "tool" && message.toolCallId === part.id,
                  ),
              ).toMatchObject({
                content: JSON.stringify({
                  approved: false,
                  message: "User denied this action",
                }),
                metadata: { tanstack: { toolResultOutcome: "denied" } },
              });
            } else {
              expect(part.state).toBe("complete");
              expect(result?.state).toBe("complete");
            }
          }
        }
      },
    ),
    { numRuns: 20 },
  );
});

test("SDK-resolved MCP tools retain server ownership behind approval, including lazy discovery", async () => {
  for (const lazy of [false, true]) {
    let iteration = 0;
    let executed = 0;
    const mcpTool = toolDefinition({
      name: "mcp__fixture__read",
      description: "Read a document",
    }).server(() => {
      executed++;
      return {};
    });
    const adapter: AnyTextAdapter = {
      ...scriptedAdapterBase,
      async *chatStream({ model, runId, threadId }) {
        const index = iteration++;
        const discovery = lazy && index === 0;
        yield* scriptedTurnChunks(
          {
            type: "step",
            toolCalls: discovery
              ? [
                  {
                    toolCallId: "discover",
                    toolName: DISCOVERY_TOOL_NAME,
                    arguments: JSON.stringify({ toolNames: [mcpTool.name] }),
                  },
                ]
              : [
                  { toolCallId: "gate", toolName: "gate", arguments: "{}" },
                  {
                    toolCallId: "mcp-read",
                    toolName: mcpTool.name,
                    arguments: "{}",
                  },
                ],
          },
          {
            index,
            model,
            runId: runId ?? "run",
            threadId: threadId ?? "thread",
          },
        );
      },
      structuredOutput: () => panic("No structured output in this test"),
    };
    const capture = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => message,
    });
    const starts: PublicToolCallStartChunk[] = [];
    for await (const chunk of streamChatChunks({
      adapter,
      messages: [],
      tools: [
        toolDefinition({
          name: "gate",
          description: "Approve write",
          needsApproval: true,
        }).server(() => ({})),
      ],
      mcp: {
        clients: [
          { tools: async () => [{ ...mcpTool, lazy }], close: async () => {} },
        ],
        lazyTools: lazy,
      },
    })) {
      if (chunk.type === EventType.TOOL_CALL_START) {
        starts.push(chunk);
      }
      capture.processor.processChunk(chunk);
    }
    const deferred = capture.processor
      .getMessages()
      .flatMap(({ parts }) => parts)
      .find((part) => part.type === "tool-call" && part.id === "mcp-read");
    expect(deferred).toMatchObject({ state: "input-complete" });
    expect(isServerChatToolCall(deferred)).toBe(true);
    expect(
      starts.find((chunk) => chunk.toolCallId === "mcp-read")?.metadata,
    ).toMatchObject({ [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" });
    expect(executed).toBe(0);
  }
});

test("a continuation snapshot preserves normalized legacy server ownership", async () => {
  const call = {
    type: "tool-call",
    id: "legacy-server",
    name: "list_templates",
    arguments: "{}",
    input: {},
    output: { templates: [] },
    state: "complete",
    metadata: { provider: "legacy" },
  } as const;
  const historical = chatMessageFromPersisted({
    id: toSafeId<"chatMessage">("msg_legacy_server_snapshot"),
    role: "assistant",
    content: toPersistedChatMessageContentV3({
      data: [normalizeStoredChatToolExecutor(call)],
    }),
  });
  const beforeRefs = chatRefsWrittenIn({
    parts: historical.parts,
    isServerTool: isServerChatToolCall,
  });
  const capture = createStreamMessageCapture({
    initialMessages: [historical],
    capture: (message) => message,
  });
  const adapter: AnyTextAdapter = {
    ...scriptedAdapterBase,
    async *chatStream({ model, runId, threadId }) {
      yield* scriptedTurnChunks(
        {
          type: "step",
          toolCalls: [
            { toolCallId: "gate", toolName: "gate", arguments: "{}" },
          ],
        },
        {
          index: 0,
          model,
          runId: runId ?? "run",
          threadId: threadId ?? "thread",
        },
      );
    },
    structuredOutput: () => panic("No structured output in this test"),
  };
  for await (const chunk of streamChatChunks({
    adapter,
    messages: [historical],
    tools: [
      toolDefinition({
        name: "gate",
        description: "Approval",
        needsApproval: true,
      }).server(() => ({})),
      toolDefinition({
        name: call.name,
        description: "Changed registration",
      }).client(),
    ],
  })) {
    capture.processor.processChunk(chunk);
  }
  const restored = capture.processor
    .getMessages()
    .flatMap(({ parts }) => parts)
    .find((part) => part.type === "tool-call" && part.id === call.id);
  expect(isChatPart(restored)).toBe(true);
  if (isChatPart(restored)) {
    expect(restored).toMatchObject({
      metadata: {
        provider: "legacy",
        [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server",
      },
      output: call.output,
    });
    const read = normalizePersistedChatMessageContent(
      toPersistedChatMessageContentV3({ data: [restored] }),
    );
    expect(read.parts).toEqual(historical.parts);
    expect(
      chatRefsWrittenIn({
        parts: read.parts,
        isServerTool: isServerChatToolCall,
      }),
    ).toEqual(beforeRefs);
  }
});

test("snapshots retain a stored executor when its tool definition changes", async () => {
  for (const executor of ["client", "server"] as const) {
    const historical = {
      id: "historical",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "history-call",
          name: "history",
          arguments: "{}",
          input: {},
          output: {},
          state: "complete",
          metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: executor },
        },
      ],
    } satisfies UIMessage;
    const adapter: AnyTextAdapter = {
      ...scriptedAdapterBase,
      async *chatStream({ model, runId, threadId }) {
        yield* scriptedTurnChunks(
          {
            type: "step",
            toolCalls: [
              {
                toolCallId: "gate",
                toolName: "gate",
                arguments: "{}",
              },
            ],
          },
          {
            index: 0,
            model,
            runId: runId ?? "run",
            threadId: threadId ?? "thread",
          },
        );
      },
      structuredOutput: () => panic("No structured output in this test"),
    };
    const definition = toolDefinition({
      name: "history",
      description: "Historical call",
    });
    const capture = createStreamMessageCapture({
      initialMessages: [historical],
      capture: (message) => message,
    });
    for await (const chunk of streamChatChunks({
      adapter,
      messages: [historical],
      tools: [
        toolDefinition({
          name: "gate",
          description: "Approval gate",
          needsApproval: true,
        }).server(() => ({})),
        executor === "client"
          ? definition.server(() => ({}))
          : definition.client(),
      ],
    })) {
      capture.processor.processChunk(chunk);
    }
    const call = capture.processor
      .getMessages()
      .flatMap(({ parts }) => parts)
      .find((part) => part.type === "tool-call" && part.id === "history-call");
    expect(call).toMatchObject({
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: executor },
    });
  }
});

test("a plain client request after a pending gate can finish while server successors wait", async () => {
  let iteration = 0;
  let documentVersion = 0;
  const executed: string[] = [];
  const versions: number[] = [];
  const adapter: AnyTextAdapter = {
    ...scriptedAdapterBase,
    async *chatStream({ model, runId, threadId }) {
      const index = iteration++;
      yield* scriptedTurnChunks(
        index === 0
          ? {
              type: "step",
              toolCalls: [
                "approved_write",
                "client_lookup",
                "write_document",
                "read_document",
              ].map((toolName, at) => ({
                toolCallId: `client-order-${at}`,
                toolName,
                arguments: "{}",
              })),
            }
          : { type: "step", text: "Document updated", toolCalls: [] },
        { index, model, runId: runId ?? "run", threadId: threadId ?? "thread" },
      );
    },
    structuredOutput: () => panic("No structured output in this test"),
  };
  const tools = [
    toolDefinition({
      name: "approved_write",
      description: "Approved write",
      needsApproval: true,
    }).server(async () => {
      await sleep(0);
      executed.push("approved_write");
      versions.push(++documentVersion);
      return { version: documentVersion };
    }),
    toolDefinition({
      name: "client_lookup",
      description: "Client lookup",
    }).client(),
    toolDefinition({
      name: "write_document",
      description: "Document write",
    }).server(async () => {
      await sleep(0);
      executed.push("write_document");
      versions.push(++documentVersion);
      return { version: documentVersion };
    }),
    toolDefinition({
      name: "read_document",
      description: "Document read",
    }).server(() => {
      executed.push("read_document");
      versions.push(documentVersion);
      return { version: documentVersion };
    }),
  ];
  const { processor } = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  const interrupts: string[] = [];
  for await (const chunk of streamChatChunks({
    adapter,
    messages: [],
    tools,
  })) {
    processor.processChunk(chunk);
    if (
      chunk.type === EventType.RUN_FINISHED &&
      chunk.outcome?.type === "interrupt"
    ) {
      interrupts.push(
        ...chunk.outcome.interrupts.map((interrupt) => {
          if (interrupt.toolCallId === undefined) {
            panic("Tool interrupt lost its call identity");
          }
          return `${interrupt.toolCallId}:${interrupt.reason}`;
        }),
      );
    }
  }
  expect(iteration).toBe(1);
  expect(interrupts).toEqual([
    "client-order-0:tool_call",
    "client-order-1:tanstack:client_tool_execution",
  ]);
  expect(executed).toEqual([]);
  const owningMessageId = processor
    .getMessages()
    .find(({ parts }) =>
      parts.some(
        (part) => part.type === "tool-call" && part.id === "client-order-1",
      ),
    )?.id;
  expect(owningMessageId).toBeDefined();
  const clientOutput = { value: "Client lookup finished" };
  processor.addToolResult("client-order-1", clientOutput);
  const completedClient = processor
    .getMessages()
    .find(({ id }) => id === owningMessageId)
    ?.parts.find(
      (part) => part.type === "tool-call" && part.id === "client-order-1",
    );
  expect(completedClient).toMatchObject({
    type: "tool-call",
    state: "complete",
    output: clientOutput,
  });
  expect(executed).toEqual([]);
  const pending = processor
    .getMessages()
    .flatMap(({ parts }) => parts)
    .find((part) => part.type === "tool-call" && part.id === "client-order-0");
  if (pending?.type !== "tool-call" || pending.approval === undefined) {
    panic("The gate must remain pending while the client finishes");
  }
  expect(pending.state).toBe("approval-requested");
  processor.addToolApprovalResponse(pending.approval.id, true);
  for await (const chunk of streamChatChunks({
    adapter,
    messages: processor.getMessages(),
    tools,
  })) {
    processor.processChunk(chunk);
  }
  expect(iteration).toBe(2);
  expect(executed).toEqual([
    "approved_write",
    "write_document",
    "read_document",
  ]);
  expect(versions).toEqual([1, 2, 2]);
  const settledCalls = processor
    .getMessages()
    .flatMap(({ parts }) => parts)
    .filter((part) => part.type === "tool-call");
  expect(settledCalls).toHaveLength(4);
  expect(settledCalls.every((part) => part.state === "complete")).toBe(true);
  expect(
    settledCalls.find((part) => part.id === "client-order-1"),
  ).toMatchObject({ output: clientOutput });
});

type StrippedChunkType = keyof typeof STRIPPED_CHUNK_KEYS;

/**
 * The spec-shaped minimum for each event type the table covers. Total over the
 * table, so a new row cannot land without a chunk to probe it with.
 */
const PROBE_BASE = {
  RUN_FINISHED: {
    type: EventType.RUN_FINISHED,
    threadId: "probe-thread",
    runId: "probe-run",
  },
  RUN_ERROR: {
    type: EventType.RUN_ERROR,
    message: "probe-message",
    code: "probe-code",
  },
  TOOL_CALL_START: {
    type: EventType.TOOL_CALL_START,
    toolCallId: "probe-call",
    toolCallName: "spec_tool",
  },
  TOOL_CALL_END: {
    type: EventType.TOOL_CALL_END,
    toolCallId: "probe-call",
  },
  TEXT_MESSAGE_CONTENT: {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "probe-message-id",
    delta: "probe-delta",
  },
  TOOL_CALL_ARGS: {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "probe-call",
    delta: "probe-delta",
  },
} as const satisfies Record<StrippedChunkType, StreamChunk>;

/**
 * One value per key the table names. Shapes the engine inspects (`error`,
 * `finishReason`, `state`) carry a value it accepts, so normalization takes
 * the branch it takes in production.
 */
const PROBE_VALUES = {
  args: '{"probe":true}',
  content: "probe-content",
  error: { message: "probe-error", code: "probe-error-code" },
  finishReason: "stop",
  input: { probe: "input" },
  model: "probe-model",
  output: { probe: "output" },
  result: "probe-result",
  runId: "probe-run",
  state: "output-available",
  threadId: "probe-thread",
  toolName: "probe_tool",
} as const satisfies Record<string, unknown>;

/**
 * Of the keys the engine takes off a chunk, the ones it re-files under
 * `metadata.tanstack`. The rest are dropped: `error` folds into the spec
 * `message`/`code`, `result` leaves as a separate `TOOL_CALL_RESULT`,
 * `toolName` on a start event folds into `toolCallName`, and the two delta
 * events lose their trio outright.
 */
const MOVED_TO_METADATA = {
  RUN_FINISHED: ["finishReason", "model"],
  RUN_ERROR: ["finishReason", "model", "runId", "threadId"],
  TOOL_CALL_START: [],
  TOOL_CALL_END: ["input", "output", "state", "toolName"],
  TEXT_MESSAGE_CONTENT: [],
  TOOL_CALL_ARGS: [],
} as const satisfies Record<StrippedChunkType, readonly string[]>;

const strippedKeysOf = (chunkType: StrippedChunkType): readonly string[] =>
  STRIPPED_CHUNK_KEYS[chunkType];

// Enumerated so the loop below is typed by event; the first test pins it
// against the table's own keys, so a new row cannot go unprobed.
const strippedChunkTypes = [
  "RUN_FINISHED",
  "RUN_ERROR",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "TEXT_MESSAGE_CONTENT",
  "TOOL_CALL_ARGS",
] as const satisfies readonly StrippedChunkType[];

// `AdapterYieldChunk` is the pre-normalization shape the engine takes: a spec
// event plus every non-spec key an adapter may set. The keys go on by
// assignment because they are exactly the ones a spec event type does not
// declare, which is what the probe is for.
const probeChunkFor = (chunkType: StrippedChunkType): AdapterYieldChunk => {
  const probe: AdapterYieldChunk = { ...PROBE_BASE[chunkType] };
  for (const key of strippedKeysOf(chunkType)) {
    Object.assign(probe, { [key]: Reflect.get(PROBE_VALUES, key) });
  }
  return probe;
};

const isChunkOfType =
  <TType extends StrippedChunkType>(chunkType: TType) =>
  (chunk: PublicStreamChunk): chunk is PublicChunkOfType<TType> =>
    chunk.type === chunkType;

const normalizedProbe = <TType extends StrippedChunkType>(
  chunkType: TType,
): PublicChunkOfType<TType> => {
  // A `TOOL_CALL_END` carrying a `result` also yields a `TOOL_CALL_RESULT`;
  // the event under test is the one that kept its own type.
  const normalized = normalizeStreamChunk(probeChunkFor(chunkType)).find(
    isChunkOfType(chunkType),
  );
  if (normalized === undefined) {
    throw new Error(`normalizeStreamChunk dropped ${chunkType}`);
  }
  return normalized;
};

const tanstackMetadataOf = (chunk: object): Record<string, unknown> => {
  const metadata: unknown = Reflect.get(chunk, "metadata");
  const tanstack: unknown =
    typeof metadata === "object" && metadata !== null
      ? Reflect.get(metadata, "tanstack")
      : undefined;
  return typeof tanstack === "object" && tanstack !== null
    ? { ...tanstack }
    : {};
};

describe("engine-emitted chunk shape", () => {
  test("every key the table names has a probe value", () => {
    const unprobed = strippedChunkTypes
      .flatMap(strippedKeysOf)
      .filter((key) => !Object.hasOwn(PROBE_VALUES, key));
    expect(unprobed).toEqual([]);
  });

  test("every row of the table is probed", () => {
    expect(Object.keys(STRIPPED_CHUNK_KEYS).toSorted()).toEqual(
      [...strippedChunkTypes].toSorted(),
    );
  });

  for (const chunkType of strippedChunkTypes) {
    describe(chunkType, () => {
      test("loses exactly the keys the table names", () => {
        const source = probeChunkFor(chunkType);
        const normalized = normalizedProbe(chunkType);
        const removed = Object.keys(source).filter(
          (key) => !Object.hasOwn(normalized, key),
        );
        expect(removed.toSorted()).toEqual(
          [...strippedKeysOf(chunkType)].toSorted(),
        );
      });

      test("re-files exactly the moved keys under metadata.tanstack", () => {
        const normalized = normalizedProbe(chunkType);
        const tanstack = tanstackMetadataOf(normalized);
        const moved: readonly string[] = MOVED_TO_METADATA[chunkType];
        const stripped = strippedKeysOf(chunkType);
        expect(
          Object.keys(tanstack)
            .filter((key) => stripped.includes(key))
            .toSorted(),
        ).toEqual([...moved].toSorted());
        for (const key of moved) {
          expect(tanstack[key]).toEqual(Reflect.get(PROBE_VALUES, key));
        }
      });
    });
  }
});

describe("chunk readers", () => {
  test("read the finish reason from a normalized run and from a synthetic one", () => {
    expect(finishReasonOf(normalizedProbe("RUN_FINISHED"))).toBe("stop");

    const synthetic: PublicRunFinishedChunk = {
      type: EventType.RUN_FINISHED,
      threadId: "probe-thread",
      runId: "probe-run",
      metadata: { tanstack: { finishReason: "length" } },
    };
    expect(finishReasonOf(synthetic)).toBe("length");

    const reasonless: PublicRunFinishedChunk = {
      type: EventType.RUN_FINISHED,
      threadId: "probe-thread",
      runId: "probe-run",
    };
    expect(finishReasonOf(reasonless)).toBeNull();
  });

  test("read tool-call input, output, and name from a normalized end event", () => {
    const normalized = normalizedProbe("TOOL_CALL_END");
    expect(toolCallEndInputOf(normalized)).toEqual({ probe: "input" });
    expect(toolCallEndOutputOf(normalized)).toEqual({ probe: "output" });
    expect(toolCallNameOf(normalized)).toBe("probe_tool");
  });

  test("read the same fields off a chunk that never went through the engine", () => {
    const synthetic: PublicToolCallEndChunk = {
      type: EventType.TOOL_CALL_END,
      toolCallId: "probe-call",
      metadata: {},
    };
    Object.assign(synthetic, {
      input: { probe: "input" },
      output: { probe: "output" },
      toolName: "probe_tool",
    });
    expect(toolCallEndInputOf(synthetic)).toEqual({ probe: "input" });
    expect(toolCallEndOutputOf(synthetic)).toEqual({ probe: "output" });
    expect(toolCallNameOf(synthetic)).toBe("probe_tool");
  });

  test("prefer the spec tool name on a start event", () => {
    expect(toolCallNameOf(normalizedProbe("TOOL_CALL_START"))).toBe(
      "spec_tool",
    );
  });
});

// Each directive fails the typecheck if `PublicStreamChunk` stops hiding the
// key it names, which is the whole guard: the two production defects this
// module exists for were top-level reads that compiled.
const rejectedFinishReason = (chunk: PublicRunFinishedChunk): unknown =>
  // @ts-expect-error the engine moves `finishReason` into metadata.tanstack
  chunk.finishReason;

const rejectedRunErrorPayload = (
  chunk: Extract<PublicStreamChunk, { type: EventType.RUN_ERROR }>,
): unknown =>
  // @ts-expect-error the engine folds `error` into the spec message and code
  chunk.error;

const rejectedToolCallEndInput = (chunk: PublicToolCallEndChunk): unknown =>
  // @ts-expect-error the engine moves `input` into metadata.tanstack
  chunk.input;

const rejectedToolCallStartName = (chunk: PublicToolCallStartChunk): unknown =>
  // @ts-expect-error the engine folds `toolName` into `toolCallName`
  chunk.toolName;

test("engine-emitted chunks reject a top-level read of a moved key", () => {
  expect([
    rejectedFinishReason,
    rejectedRunErrorPayload,
    rejectedToolCallEndInput,
    rejectedToolCallStartName,
  ]).toHaveLength(4);
});

test("durable runs preserve thread identity and one-off runs allocate distinct threads", async () => {
  const threads: string[] = [];
  const adapter: AnyTextAdapter = {
    ...scriptedAdapterBase,
    async *chatStream({ model, runId, threadId }) {
      if (threadId === undefined) {
        return panic(
          "The runtime must assign a thread before invoking the adapter",
        );
      }
      threads.push(threadId);
      yield* scriptedTurnChunks(
        { type: "step", text: "Done", toolCalls: [] },
        { index: 0, model, runId: runId ?? "run", threadId },
      );
    },
    structuredOutput: () => panic("No structured output in this test"),
  };
  for (const threadId of [undefined, undefined, "durable-thread"]) {
    for await (const _chunk of streamChatChunks({
      adapter,
      messages: [{ role: "user", content: "Fixture" }],
      ...(threadId === undefined ? {} : { threadId }),
    })) {
      // Drain the run so its adapter invocation completes.
    }
  }
  expect(threads).toHaveLength(3);
  expect(threads.at(0)).toBeTruthy();
  expect(threads.at(1)).toBeTruthy();
  expect(threads.at(0)).not.toBe(threads.at(1));
  expect(threads.at(2)).toBe("durable-thread");
});
