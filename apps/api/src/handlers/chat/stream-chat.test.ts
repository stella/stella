import { EventType, StreamProcessor } from "@tanstack/ai";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { createPipelineContext } from "@stll/anonymize-wasm";

import type { ScopedDb } from "@/api/db/safe-db";
import { createChatAttachmentPart } from "@/api/handlers/chat/chat-message-parts";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type {
  ChatAnonRestoration,
  ChatMessage,
} from "@/api/handlers/chat/types";
import { toUserFileUrl } from "@/api/handlers/user-files/types";
import { toSafeId } from "@/api/lib/branded-types";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
} from "@/api/lib/errors/tagged-errors";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  chatMessageUsageFromTokenUsage,
  collectInitialRestorationPlaceholders,
  createChatAttemptState,
  createChatMessageIdMapper,
  ensureAssistantMessageStart,
  hydrateMessages,
  normalizeFinalAssistantMessageId,
  processServerChatStream,
  recordChatAttemptFinish,
  remapOutgoingMessageIds,
  transformOutgoingStream,
} from "./stream-chat";

const collectChunks = async (
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};

const collectText = (chunks: readonly StreamChunk[]) => {
  let text = "";
  for (const chunk of chunks) {
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      text += chunk.delta;
    }
  }
  return text;
};

const collectReasoning = (chunks: readonly StreamChunk[]) => {
  let text = "";
  for (const chunk of chunks) {
    if (chunk.type === EventType.REASONING_MESSAGE_CONTENT) {
      text += chunk.delta;
    }
  }
  return text;
};

const stripTimestamps = (chunks: readonly StreamChunk[]) =>
  chunks.map((chunk) => {
    const { timestamp, ...rest } = chunk;
    void timestamp;
    return rest;
  });

const scopedDb: ScopedDb = async () => {
  throw new Error("Expected stream deanonymization test not to access DB");
};

describe("outgoing chat stream message ids", () => {
  test("normalizes provider assistant message ids to one stable stella UUID", async () => {
    const firstId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const ids = [firstId];
    let index = 0;
    const mapMessageId = createChatMessageIdMapper(() => {
      const nextId = ids.at(index);
      if (nextId === undefined) {
        throw new Error("Unexpected message id request");
      }
      index += 1;
      return nextId;
    });

    expect(
      await collectChunks(
        remapOutgoingMessageIds({
          mapMessageId,
          source: streamChunks([
            {
              type: EventType.TEXT_MESSAGE_START,
              messageId: "openrouter-responses-a",
              role: "assistant",
            },
            {
              type: EventType.TEXT_MESSAGE_CONTENT,
              delta: "Ahoj",
              messageId: "openrouter-responses-a",
            },
            {
              type: EventType.CUSTOM,
              name: "structured-output.start",
              value: { messageId: "openrouter-responses-a" },
            },
            {
              type: EventType.TOOL_CALL_START,
              parentMessageId: "openrouter-responses-b",
              toolCallId: "tool-1",
              toolCallName: "ask-user",
              // eslint-disable-next-line typescript/no-deprecated -- AG-UI still requires the compatibility field.
              toolName: "ask-user",
            },
            {
              type: EventType.TOOL_CALL_RESULT,
              content: "{}",
              messageId: "openrouter-responses-b",
              toolCallId: "tool-1",
            },
            {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "openrouter-responses-a",
            },
          ]),
        }),
      ),
    ).toEqual([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: firstId,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Ahoj",
        messageId: firstId,
      },
      {
        type: EventType.CUSTOM,
        name: "structured-output.start",
        value: { messageId: firstId },
      },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: firstId,
        toolCallId: "tool-1",
        toolCallName: "ask-user",
        // eslint-disable-next-line typescript/no-deprecated -- AG-UI still requires the compatibility field.
        toolName: "ask-user",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        content: "{}",
        messageId: firstId,
        toolCallId: "tool-1",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: firstId,
      },
    ]);
    expect(index).toBe(1);
  });

  test("normalizes tanstack generated final assistant ids before persistence", () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const mapMessageId = createChatMessageIdMapper(() => messageId);

    expect(mapMessageId("provider-stream-message")).toBe(messageId);
    expect(
      normalizeFinalAssistantMessageId({
        mapMessageId,
        message: {
          id: "msg-1781251066139-vhjhi8",
          role: "assistant",
          parts: [
            {
              content: "Checking source law.",
              type: "thinking",
            },
            {
              arguments: "{}",
              id: "tool-1",
              name: "ask-user",
              state: "input-complete",
              type: "tool-call",
            },
          ],
        },
      }),
    ).toEqual({
      id: messageId,
      role: "assistant",
      parts: [
        {
          content: "Checking source law.",
          type: "thinking",
        },
        {
          arguments: "{}",
          id: "tool-1",
          name: "ask-user",
          state: "input-complete",
          type: "tool-call",
        },
      ],
    });
  });

  test("seeds tanstack message state before reasoning-only chunks", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const threadId = "thread-1";
    const mapMessageId = createChatMessageIdMapper(() => messageId);
    const responseMessageIds: string[] = [];
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessageIds.push(message.id);
        },
      },
    });
    const chunks = ensureAssistantMessageStart({
      getOrCreateMessageId: () => mapMessageId("assistant-response"),
      source: remapOutgoingMessageIds({
        mapMessageId,
        source: streamChunks([
          { type: EventType.RUN_STARTED, runId: "run-1", threadId },
          {
            type: EventType.REASONING_MESSAGE_CONTENT,
            delta: "Checking source law.",
            messageId: "openrouter-reasoning-message",
          },
          {
            type: EventType.REASONING_MESSAGE_END,
            messageId: "openrouter-reasoning-message",
          },
          {
            type: EventType.RUN_FINISHED,
            finishReason: "stop",
            runId: "run-1",
            threadId,
          },
        ]),
      }),
    });

    const emitted = await collectChunks(chunks);
    for (const chunk of emitted) {
      processor.processChunk(chunk);
    }

    expect(stripTimestamps(emitted)).toEqual([
      { type: EventType.RUN_STARTED, runId: "run-1", threadId },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "Checking source law.",
        messageId,
      },
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId,
      },
      {
        type: EventType.RUN_FINISHED,
        finishReason: "stop",
        runId: "run-1",
        threadId,
      },
    ]);
    expect(responseMessageIds).toEqual([messageId]);
  });

  test("defers run finished until assistant persistence has completed", async () => {
    const events: string[] = [];
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          events.push("processor:onStreamEnd");
          responseMessage = {
            id: message.id,
            parts: [{ content: "Ahoj", type: "text" }],
            role: "assistant",
          };
        },
      },
    });
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      getResponseMessage: () => responseMessage,
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: () => {
        events.push("server:onFinish");
      },
      processor,
      source: streamChunks([
        {
          type: EventType.RUN_STARTED,
          runId: "run-1",
          threadId: "thread-1",
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Ahoj",
          messageId: "provider-message",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "provider-message",
        },
        {
          type: EventType.RUN_FINISHED,
          finishReason: "stop",
          runId: "run-1",
          threadId: "thread-1",
        },
      ]),
    });

    const emittedTypes: string[] = [];
    for await (const chunk of stream) {
      emittedTypes.push(chunk.type);
      events.push(`yield:${chunk.type}`);
    }

    expect(emittedTypes).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events).toEqual([
      "yield:RUN_STARTED",
      "yield:TEXT_MESSAGE_START",
      "yield:TEXT_MESSAGE_CONTENT",
      "yield:TEXT_MESSAGE_END",
      "processor:onStreamEnd",
      "server:onFinish",
      "yield:RUN_FINISHED",
    ]);
  });

  test("persists partial assistant messages when the stream aborts after content", async () => {
    const abortController = new AbortController();
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let responseMessage: ChatMessage | null = null;
    const processor = new StreamProcessor({
      events: {
        onStreamEnd: (message) => {
          responseMessage = {
            id: message.id,
            parts: [
              {
                content: message.parts
                  .map((part) => (part.type === "text" ? part.content : ""))
                  .join(""),
                type: "text",
              },
            ],
            role: message.role,
          };
        },
      },
    });
    const finishEvents: { isAborted: boolean; text: string }[] = [];

    const stream = processServerChatStream({
      abortSignal: abortController.signal,
      getResponseMessage: () => responseMessage,
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: ({ isAborted, responseMessage: finishedMessage }) => {
        finishEvents.push({
          isAborted,
          text: finishedMessage.parts
            .map((part) => (part.type === "text" ? part.content : ""))
            .join(""),
        });
      },
      processor,
      source: streamChunksThenAbort({
        abortController,
        chunks: [
          {
            type: EventType.RUN_STARTED,
            runId: "run-1",
            threadId: "thread-1",
          },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "provider-message",
            role: "assistant",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            delta: "Partial answer",
            messageId: "provider-message",
          },
        ],
      }),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Partial answer",
        messageId,
      },
      {
        type: EventType.RUN_ERROR,
        message: "unknown",
        code: "unknown",
      },
    ]);
    expect(finishEvents).toEqual([{ isAborted: true, text: "Partial answer" }]);
  });

  test("normalizes in-band provider run errors", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      getResponseMessage: () => null,
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: () => {
        throw new Error("Expected run error not to finish");
      },
      processor: new StreamProcessor(),
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.RUN_ERROR,
          message: "upstream quota",
          rawEvent: { statusCode: 429 },
        },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
      {
        type: EventType.RUN_ERROR,
        message: "quota_exhausted",
        code: "quota_exhausted",
        rawEvent: { statusCode: 429 },
      },
    ]);
  });

  test("does not finish successfully after an in-band run error", async () => {
    const messageId = toSafeId<"chatMessage">(
      "11111111-1111-4111-8111-111111111111",
    );
    let finished = false;
    const stream = processServerChatStream({
      abortSignal: new AbortController().signal,
      getResponseMessage: () => null,
      mapMessageId: createChatMessageIdMapper(() => messageId),
      onFinish: () => {
        finished = true;
      },
      processor: new StreamProcessor(),
      source: streamChunks([
        { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "provider-message",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Partial answer",
          messageId: "provider-message",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "provider-message",
        },
        {
          type: EventType.RUN_ERROR,
          message: "upstream billing",
          rawEvent: { statusCode: 402 },
        },
      ]),
    });

    const chunks = await collectChunks(stream);

    expect(stripTimestamps(chunks).at(-1)).toEqual({
      type: EventType.RUN_ERROR,
      message: "provider_billing",
      code: "provider_billing",
      rawEvent: { statusCode: 402 },
    });
    expect(finished).toBe(false);
  });
});

describe("chat message usage metadata", () => {
  test("preserves provider-reported reasoning tokens", () => {
    expect(
      chatMessageUsageFromTokenUsage({
        completionTokens: 22,
        completionTokensDetails: { reasoningTokens: 12 },
        promptTokens: 10,
        totalTokens: 32,
      }),
    ).toEqual({
      completionTokens: 22,
      completionTokensDetails: { reasoningTokens: 12 },
      promptTokens: 10,
      totalTokens: 32,
    });
  });
});

describe("chat attempt terminal classification", () => {
  test("captures empty stop completions", () => {
    const state = createChatAttemptState();
    const capturedErrors: unknown[] = [];

    recordChatAttemptFinish({
      captureError: (error) => {
        capturedErrors.push(error);
      },
      finishReason: "stop",
      messages: [],
      modelInfo: { modelId: "gpt-test", provider: "openai" },
      state,
      threadId: toSafeId<"chatThread">("11111111-1111-4111-8111-111111111111"),
      usage: {
        completionTokens: 0,
        promptTokens: 12,
        totalTokens: 12,
      },
    });

    expect(state.emptyCompletion).toBeInstanceOf(ChatEmptyCompletionError);
    expect(state.finalLoopDetection).toBeNull();
    expect(capturedErrors).toEqual([state.emptyCompletion]);
  });

  test("surfaces final content loops", () => {
    const state = createChatAttemptState();
    const loopChunk = "abcdefghij".repeat(5);
    const messages: ModelMessage[] = [
      { content: "Please answer.", role: "user" },
      { content: loopChunk.repeat(10), role: "assistant" },
    ];

    recordChatAttemptFinish({
      captureError: () => {},
      finishReason: "stop",
      messages,
      modelInfo: { modelId: "gpt-test", provider: "openai" },
      state,
      threadId: toSafeId<"chatThread">("11111111-1111-4111-8111-111111111111"),
      usage: {
        completionTokens: 50,
        promptTokens: 12,
        totalTokens: 62,
      },
    });

    expect(state.finalLoopDetection).toBeInstanceOf(ChatLoopDetectedError);
    expect(state.emptyCompletion).toBeNull();
  });
});

const createBoundary = (
  pairs: readonly (readonly [string, string])[],
): Extract<ChatThirdPartyBoundary, { type: "anonymized" }> => ({
  anonymizationScopeId: "workspace-A",
  gazetteerEntries: Promise.resolve([]),
  excludedCanonicals: Promise.resolve([]),
  organizationId: toSafeId<"organization">("org_test"),
  pipelineContext: createPipelineContext(),
  placeholderOffsets: new Map<string, number>(),
  redactionMap: new Map(pairs),
  scopedDb,
  type: "anonymized",
});

const streamChunks = async function* (
  chunks: readonly StreamChunk[],
): AsyncIterable<StreamChunk> {
  yield* chunks;
};

const streamChunksThenAbort = async function* ({
  abortController,
  chunks,
}: {
  abortController: AbortController;
  chunks: readonly StreamChunk[];
}): AsyncIterable<StreamChunk> {
  yield* chunks;
  const error = new Error("Stream aborted");
  abortController.abort(error);
  throw error;
};

describe("chat stream refs", () => {
  test("resolves assistant text refs across streamed chunk boundaries", async () => {
    const chunks: StreamChunk[] = [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Open [Document](",
        messageId: "text_1",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "#stella-entity-ref=",
        messageId: "text_1",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "ent_1) now.",
        messageId: "text_1",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "text_1" },
    ];

    const resolvedChunks = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantTextRefs: (text) =>
          text.replace(
            "#stella-entity-ref=ent_1",
            "#stella-entity=workspace_1:entity_1",
          ),
      }),
    );

    expect(collectText(resolvedChunks)).toBe(
      "Open [Document](#stella-entity=workspace_1:entity_1) now.",
    );
  });

  test("resolves assistant reasoning refs across streamed chunk boundaries", async () => {
    const chunks: StreamChunk[] = [
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "Check [Document](",
        messageId: "reasoning_1",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "#stella-entity-ref=",
        messageId: "reasoning_1",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "ent_1) first.",
        messageId: "reasoning_1",
      },
      { type: EventType.REASONING_MESSAGE_END, messageId: "reasoning_1" },
    ];

    const resolvedChunks = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantTextRefs: (text) =>
          text.replace(
            "#stella-entity-ref=ent_1",
            "#stella-entity=workspace_1:entity_1",
          ),
      }),
    );

    expect(collectReasoning(resolvedChunks)).toBe(
      "Check [Document](#stella-entity=workspace_1:entity_1) first.",
    );
  });

  test("resolves newly created document mentions in assistant text", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
    const mention = registry.toEntityMention({
      entityId,
      label: "Mzuri_Umowa_Strona_1.docx",
      workspaceId,
    });

    const chunks: StreamChunk[] = [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: `Utworzyłem nowy dokument ${mention}.`,
        messageId: "text_1",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "text_1" },
    ];

    const resolvedChunks = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantTextRefs: registry.resolveAssistantTextRefs,
        resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
      }),
    );

    expect(collectText(resolvedChunks)).toBe(
      "Utworzyłem nowy dokument " +
        "[Mzuri_Umowa_Strona_1.docx](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34).",
    );
  });

  test("resolves refs in streamed tool outputs for the live UI", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
    const mention = registry.toEntityMention({
      entityId,
      label: "Mzuri_Umowa_Strona_1.docx",
      workspaceId,
    });

    const chunks: StreamChunk[] = [
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "message_1",
        toolCallId: "tool_1",
        content: JSON.stringify({
          fileName: "Mzuri_Umowa_Strona_1.docx",
          href: "#stella-entity-ref=ent_1",
          mention,
          success: true,
        }),
      },
    ];

    const [resolvedChunk] = await collectChunks(
      transformOutgoingStream({
        boundary: { type: "raw" },
        initialRestorationPlaceholders: new Set(),
        restorationPairs: [],
        source: streamChunks(chunks),
        resolveAssistantTextRefs: registry.resolveAssistantTextRefs,
        resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
      }),
    );

    expect(resolvedChunk).toEqual({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "message_1",
      toolCallId: "tool_1",
      content: JSON.stringify({
        fileName: "Mzuri_Umowa_Strona_1.docx",
        href: "#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34",
        mention:
          "[Mzuri_Umowa_Strona_1.docx](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34)",
        success: true,
      }),
    });
  });
});

describe("chat message hydration", () => {
  test("refuses stored attachments that cannot be text-hydrated for anonymized third-party sends", async () => {
    const userFileId = toSafeId<"userFile">(
      "11111111-1111-4111-8111-111111111111",
    );
    const threadId = toSafeId<"chatThread">(
      "22222222-2222-4222-8222-222222222222",
    );
    const userId = toSafeId<"user">("33333333-3333-4333-8333-333333333333");
    const { safeDb } = createScopedDbMock({
      query: {
        userFiles: {
          findMany: async () => [
            {
              id: userFileId,
              userId,
              threadId,
              fileName: "draft.pdf",
              mimeType: PDF_MIME_TYPE,
              s3Key: "user/file",
            },
          ],
        },
      },
    });

    const result = await hydrateMessages({
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [
            createChatAttachmentPart({
              filename: "draft.pdf",
              mimeType: PDF_MIME_TYPE,
              url: toUserFileUrl(userFileId),
            }),
          ],
        },
      ],
      safeDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      userId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected PDF hydration refusal");
    }

    if (!("status" in result.error)) {
      throw result.error;
    }

    expect(result.error.status).toBe(422);
  });
});

describe("anonymized outgoing chat stream", () => {
  test("seeds restorations from the current provider-visible message only", () => {
    const placeholders = collectInitialRestorationPlaceholders({
      latestMessageId: "current",
      messages: [
        {
          id: "previous",
          role: "assistant",
          parts: [{ type: "text", content: "Earlier [PERSON_3]" }],
        },
        {
          id: "current",
          role: "user",
          parts: [
            {
              type: "text",
              content: "Does [PERSON_1] involve [PERSON_2]?",
            },
          ],
        },
      ],
      redactionMap: new Map([
        ["[PERSON_1]", "System and user shared name"],
        ["[PERSON_2]", "Current user only"],
        ["[PERSON_3]", "Prior assistant only"],
      ]),
    });

    expect([...placeholders]).toEqual(["[PERSON_1]", "[PERSON_2]"]);
  });

  test("does not emit system-context-only restoration pairs", async () => {
    const boundary = createBoundary([
      ["[PERSON_1]", "System Only"],
      ["[PERSON_2]", "Jan Novak"],
    ]);
    const restorationPairs: ChatAnonRestoration[] = [];
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(["[PERSON_2]"]),
      restorationPairs,
      source: streamChunks([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "text-1",
          delta: "Hello",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "text-1" },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "text-1",
        delta: "Hello",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "text-1" },
    ]);
    expect(restorationPairs).toEqual([
      { placeholder: "[PERSON_2]", original: "Jan Novak" },
    ]);
  });

  test("emits a restoration pair when assistant text uses a placeholder", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "text-1",
          delta: "[PERSON_1]",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "text-1" },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.CUSTOM,
        name: "stella.anon-restorations",
        value: {
          pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novak" }],
        },
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "text-1",
        delta: "Jan Novak",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "text-1" },
    ]);
  });

  test("emits a restoration pair when assistant reasoning uses a placeholder", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "reasoning-1",
          delta: "[PERSON_1]",
        },
        { type: EventType.REASONING_MESSAGE_END, messageId: "reasoning-1" },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.CUSTOM,
        name: "stella.anon-restorations",
        value: {
          pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novak" }],
        },
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "Jan Novak",
      },
      { type: EventType.REASONING_MESSAGE_END, messageId: "reasoning-1" },
    ]);
  });

  test("restores bracketless placeholders in user-visible tool input", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = transformOutgoingStream({
      boundary,
      initialRestorationPlaceholders: new Set(),
      restorationPairs: [],
      source: streamChunks([
        {
          type: EventType.CUSTOM,
          name: "tool-input-available",
          value: {
            toolCallId: "tool_1",
            toolName: "ask-user",
            input: {
              options: ["Call PERSON_1", "Email [PERSON_1]"],
              question: "How should PERSON_1 be contacted?",
            },
          },
        },
      ]),
    });

    expect(stripTimestamps(await collectChunks(stream))).toEqual([
      {
        type: EventType.CUSTOM,
        name: "stella.anon-restorations",
        value: {
          pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novak" }],
        },
      },
      {
        type: EventType.CUSTOM,
        name: "tool-input-available",
        value: {
          toolCallId: "tool_1",
          toolName: "ask-user",
          input: {
            options: ["Call Jan Novak", "Email Jan Novak"],
            question: "How should Jan Novak be contacted?",
          },
        },
      },
    ]);
  });
});
