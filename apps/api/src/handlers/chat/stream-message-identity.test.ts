import {
  chat,
  convertMessagesToModelMessages,
  EventType,
  interleaveActivityRecords,
  modelMessagesToUIMessages,
  normalizeStreamChunk,
  StreamProcessor,
} from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { expect, test } from "bun:test";

import {
  CHAT_TOOL_DECLINED_ERROR,
  isDeclinedChatToolCall,
} from "@stll/api-contract/chat";
import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import { declineToolCall } from "@/api/handlers/chat/chat-message-parts";
import {
  attachSnapshotMessageOwners,
  ensureAssistantMessageStart,
  keepDeniedApprovalsOnScreen,
  remapOutgoingMessageIds,
} from "@/api/handlers/chat/stream-message-identity";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { projectVisualPreviewStream } from "@/api/lib/visual-preview-stream";
import {
  buildWireSnapshot,
  unsafeFixture,
} from "@/api/tests/helpers/chat-fixtures";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";

const stream = async function* (chunk: StreamChunk) {
  yield chunk;
};

const collect = async (
  source: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
};

test("denial restoration preserves reconciled results across repeated snapshot passes", async () => {
  const approval = { approved: false, id: "approval-1", needsApproval: true };
  const parts = [
    {
      approval,
      arguments: "{}",
      id: "call-1",
      input: {},
      name: "delete_document",
      output: { error: CHAT_TOOL_DECLINED_ERROR },
      state: "error",
      type: "tool-call",
    },
    {
      content: JSON.stringify({ error: CHAT_TOOL_DECLINED_ERROR }),
      error: CHAT_TOOL_DECLINED_ERROR,
      state: "error",
      toolCallId: "call-1",
      type: "tool-result",
    },
  ] as const satisfies UIMessage["parts"];
  const message = {
    content: "",
    id: "assistant-1",
    parts,
    role: "assistant" as const,
    toolCalls: [
      {
        function: { arguments: "{}", name: "delete_document" },
        id: "call-1",
        type: "function" as const,
      },
    ],
  };
  const snapshot = unsafeFixture(
    "Reconciled denial snapshots carry server UI parts and wire tool calls beyond the engine serializer output",
    {
      messages: [message],
      type: EventType.MESSAGES_SNAPSHOT,
    } as const satisfies StreamChunk,
  );
  const deniedApprovals = new Map([["call-1", approval]]);
  const restored = keepDeniedApprovalsOnScreen({
    deniedApprovals,
    source: keepDeniedApprovalsOnScreen({
      deniedApprovals,
      source: stream(snapshot),
    }),
  });
  const processor = new StreamProcessor();
  for await (const chunk of restored) {
    expect(chunk).toEqual(snapshot);
    processor.processChunk(chunk);
  }
  expect(processor.getMessages().at(0)?.parts).toEqual(parts);
});

/** What a reader sees of a call: its state, decision and output. */
const callView = (part: unknown) => {
  if (
    typeof part !== "object" ||
    part === null ||
    Reflect.get(part, "type") !== "tool-call"
  ) {
    return null;
  }
  return {
    approval: Reflect.get(part, "approval"),
    id: Reflect.get(part, "id"),
    output: Reflect.get(part, "output"),
    state: Reflect.get(part, "state"),
  };
};

test("a denied call rebuilt from the engine's snapshot carries the shape the thread stores", async () => {
  const pending = {
    approval: { id: "approval_call-1", needsApproval: true },
    arguments: '{"name":"NDA"}',
    id: "call-1",
    input: { name: "NDA" },
    name: "mcp__external__delete",
    state: "approval-requested",
    type: "tool-call",
  } as const satisfies ChatPart;
  // What a reload serves for the call once the user declined it.
  const stored = declineToolCall(pending, pending.approval);
  const approval = { ...pending.approval, approved: false };
  // The engine's snapshot after the denial: the call in model form, answered
  // by the denial's tool message.
  const snapshot = unsafeFixture(
    "An engine snapshot pairs a model-form call with the tool message the engine wrote for its denial",
    {
      messages: [
        {
          content: "",
          id: "assistant-1",
          role: "assistant",
          toolCalls: [
            {
              function: { arguments: pending.arguments, name: pending.name },
              id: pending.id,
              type: "function",
            },
          ],
        },
        {
          // The text the engine's tool message carries for its denial.
          content: JSON.stringify({ error: CHAT_TOOL_DECLINED_ERROR }),
          error: CHAT_TOOL_DECLINED_ERROR,
          id: "tool-1",
          role: "tool",
          toolCallId: pending.id,
        },
      ],
      type: EventType.MESSAGES_SNAPSHOT,
    } as const satisfies StreamChunk,
  );

  const [wire] = await collect(
    keepDeniedApprovalsOnScreen({
      deniedApprovals: new Map([[pending.id, approval]]),
      source: stream(snapshot),
    }),
  );
  if (wire?.type !== EventType.MESSAGES_SNAPSHOT) {
    throw new Error("Expected the snapshot back");
  }
  const assistant = wire.messages.at(0);
  const rawParts: unknown =
    assistant === undefined ? undefined : Reflect.get(assistant, "parts");
  const wireParts: readonly unknown[] = Array.isArray(rawParts) ? rawParts : [];
  const expected = callView(stored.call);
  // The fixture reaches the fault: the stored call is settled and declined.
  expect(isDeclinedChatToolCall(stored.call)).toBe(true);
  expect(expected?.state).toBe("error");

  // The wire carries the call as stored, and so does the page that folds it.
  expect(wireParts.map(callView).filter(Boolean)).toEqual([expected]);
  const processor = new StreamProcessor();
  processor.processChunk(wire);
  const folded = processor.getMessages().flatMap(({ parts }) => parts);
  expect(folded.map(callView).filter(Boolean)).toEqual([expected]);
  expect(
    folded.flatMap((part) =>
      part.type === "tool-result"
        ? [{ error: part.error, state: part.state }]
        : [],
    ),
  ).toEqual([{ error: stored.result.error, state: stored.result.state }]);
});

test("snapshot ownership follows the actual model state through previews and buffered snapshots", async () => {
  const history: UIMessage[] = [
    {
      id: "historical",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "preview",
          name: VISUAL_PREVIEW_TOOL_NAME,
          arguments: "{}",
          state: "complete",
          output: "preview done",
        },
        {
          type: "tool-result",
          toolCallId: "preview",
          content: "preview done",
          state: "complete",
        },
        { type: "text", content: "Historical tail" },
      ],
    },
  ];
  const fresh = toSafeId<"chatMessage">("22222222-2222-4222-8222-222222222222");
  const chunks: StreamChunk[] = [];
  for (const collision of ["historical-segment-1", "another-fresh-id"]) {
    const messages = convertMessagesToModelMessages([
      ...history,
      {
        id: "current-user",
        role: "user",
        parts: [{ type: "text", content: "Continue" }],
      },
      {
        id: collision,
        role: "assistant",
        parts: [{ type: "text", content: "Fresh answer" }],
      },
    ]);
    const activities = [
      {
        id: "historical-segment-1-1",
        activityType: "progress",
        content: { status: "working" },
        index: 0,
      },
    ];
    const snapshot = buildWireSnapshot(
      interleaveActivityRecords(
        modelMessagesToUIMessages(messages),
        activities,
      ),
      { includeActivity: true },
    );
    const annotated = attachSnapshotMessageOwners(
      { messages, activities, runId: "owner-test" },
      {
        ...snapshot,
        metadata: {
          unrelated: "preserved",
          tanstack: { model: "model-diagnostic" },
        },
      },
    );
    // Buffer separate immutable chunks, then normalize/clone them as the real
    // pipeline does. No latest-map state or object identity can carry ownership.
    chunks.push(...normalizeStreamChunk(structuredClone(annotated)));
    expect(JSON.stringify(messages)).not.toContain("__stellaSnapshotOwner");
  }
  const source = async function* () {
    yield* chunks;
  };
  const unprojected = await collect(
    remapOutgoingMessageIds({
      existingMessageIds: new Set(["historical"]),
      mapMessageId: () => fresh,
      source: source(),
    }),
  );
  expect(unprojected.map(({ metadata }) => metadata)).toEqual([
    { unrelated: "preserved", tanstack: { model: "model-diagnostic" } },
    { unrelated: "preserved", tanstack: { model: "model-diagnostic" } },
  ]);
  const result = await collect(
    remapOutgoingMessageIds({
      // A removed contentless user's ID may now identify a historical segment.
      existingMessageIds: new Set(["historical", "historical-segment-1-2"]),
      mapMessageId: () => fresh,
      source: projectVisualPreviewStream(source()),
    }),
  );
  expect(result).toHaveLength(2);
  for (const chunk of result) {
    expect(chunk.metadata).toBeUndefined();
    expect(JSON.stringify(chunk)).not.toContain("__stellaSnapshotOwner");
    if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
      throw new Error("Expected snapshot");
    }
    expect(
      chunk.messages
        .filter(({ role }) => role === "assistant")
        .map(({ id, content }) => ({ id, content })),
    ).toEqual([
      { id: "historical", content: "Historical tail" },
      { id: fresh, content: "Fresh answer" },
    ]);
  }
});

test("real SDK snapshot middleware owns result segments without changing provider history", async () => {
  const history: UIMessage[] = [
    {
      id: "stored",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "old",
          name: "lookup",
          arguments: "{}",
          state: "complete",
          output: "done",
        },
        {
          type: "tool-result",
          toolCallId: "old",
          content: "done",
          state: "complete",
        },
        { type: "text", content: "Old answer" },
      ],
    },
    {
      id: "user",
      role: "user",
      parts: [{ type: "text", content: "Continue" }],
    },
  ];
  let snapshots = 0;
  const source = chat({
    adapter: createScriptedTextAdapter([
      {
        type: "tool-call",
        toolCallId: "pending",
        toolName: "ask-user",
        arguments: "{}",
      },
    ]),
    messages: history,
    tools: [
      {
        name: "ask-user",
        description: "Ask the user",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    threadId: "thread",
    runId: "stored-segment-1",
    middleware: [
      {
        name: "snapshot-owner-test",
        onChunk: (ctx, chunk) => {
          expect(JSON.stringify(ctx.messages)).not.toContain(
            "__stellaSnapshotOwner",
          );
          if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
            snapshots += 1;
          }
          return attachSnapshotMessageOwners(ctx, chunk);
        },
      },
    ],
  });
  const chunks = await collect(
    remapOutgoingMessageIds({
      existingMessageIds: new Set(history.map(({ id }) => id)),
      mapMessageId: () =>
        toSafeId<"chatMessage">("22222222-2222-4222-8222-222222222222"),
      source,
    }),
  );
  expect(snapshots).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(JSON.stringify(chunk)).not.toContain("__stellaSnapshotOwner");
    if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
      continue;
    }
    const stored = chunk.messages.filter(({ id }) => id === "stored");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      content: "Old answer",
      toolCalls: [{ id: "old" }],
    });
  }
});

test("distinct signed reasoning blocks retain their ids under one assistant owner", async () => {
  const owner = toSafeId<"chatMessage">("assistant-owner");
  const blocks = ["thinking-first", "thinking-next"];
  async function* source(): AsyncIterable<StreamChunk> {
    yield { type: EventType.RUN_STARTED, runId: "run", threadId: "thread" };
    for (const messageId of blocks) {
      yield { type: EventType.REASONING_START, messageId };
      yield {
        type: EventType.REASONING_MESSAGE_START,
        messageId,
        role: "reasoning",
      };
      yield {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId,
        delta: messageId,
      };
      yield {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: messageId,
        encryptedValue: `signature-${messageId}`,
      };
      yield { type: EventType.REASONING_MESSAGE_END, messageId };
      yield { type: EventType.REASONING_END, messageId };
    }
    yield { type: EventType.RUN_FINISHED, runId: "run", threadId: "thread" };
  }
  const chunks = await collect(
    ensureAssistantMessageStart({
      getOrCreateMessageId: () => owner,
      source: remapOutgoingMessageIds({
        mapMessageId: () => owner,
        source: source(),
      }),
    }),
  );
  expect(
    chunks.flatMap((chunk) =>
      chunk.type === EventType.REASONING_MESSAGE_CONTENT
        ? [chunk.messageId]
        : [],
    ),
  ).toEqual(blocks);
  const processor = new StreamProcessor();
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  expect(processor.getMessages().map(({ id }) => id)).toEqual([owner]);
  expect(
    processor
      .getMessages()
      .flatMap(({ parts }) => parts.filter((part) => part.type === "thinking")),
  ).toEqual(
    blocks.map((stepId) => ({
      type: "thinking",
      stepId,
      content: stepId,
      signature: `signature-${stepId}`,
    })),
  );
});
