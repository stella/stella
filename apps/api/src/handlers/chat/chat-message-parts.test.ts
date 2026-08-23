import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_RICH_PART_LIMITS,
  resourceRef,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import { propertyConfig } from "@stll/property-testing";

import {
  applyChatPartPersistenceBudget,
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  classifyChatPartForPersistence,
  createChatTextPart,
  isIncomingChatPart,
  isChatAttachmentPart,
  isChatPart,
  isProviderVisibleChatPart,
  isServerOwnedChatPart,
  normalizePersistedChatMessageContent,
  restoreServerOwnedChatParts,
  toChatMessageContent,
  toPersistedChatMessageContentV3,
  toPersistableChatMessage,
  getAwaitingUserInteraction,
  getAwaitingUserInteractions,
  getResumedUserInteraction,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { CHAT_REF_ENCODING } from "@/api/lib/chat/ref-token";
import { LIMITS } from "@/api/lib/limits";

import { richChatParts, unsafeScriptUrl } from "./__fixtures__/rich-chat-parts";

const budgetPropertyPartFromKind = (kind: number): ChatPart => {
  switch (kind) {
    case 1:
      return richChatParts[0];
    case 2:
      return richChatParts[1];
    case 3:
      return richChatParts[2];
    default:
      return createChatTextPart(String(kind));
  }
};

describe("persisted chat message parts", () => {
  test("stores one canonical parsed tool-call representation", () => {
    const input = { query: "nda" };
    const output = { results: [{ id: "document-1" }] };
    const parts = [
      {
        arguments: JSON.stringify(input),
        id: "search-1",
        input,
        name: "mcp__external__search",
        output,
        state: "complete",
        type: "tool-call",
      },
      {
        content: JSON.stringify(output),
        state: "complete",
        toolCallId: "search-1",
        type: "tool-result",
      },
    ] as const satisfies ChatPart[];

    const persisted = toPersistedChatMessageContentV3({
      data: [...parts],
    });

    expect(persisted.version).toBe(3);
    const persistedCall = persisted.data.at(0);
    expect(persistedCall?.type).toBe("tool-call");
    if (persistedCall?.type !== "tool-call") {
      return;
    }
    expect(persistedCall.input.status).toBe("parsed");
    if (persistedCall.input.status !== "parsed") {
      return;
    }
    expect(persistedCall.input.value).toEqual(input);
    expect(persistedCall.output?.value).toEqual(output);
    expect(persisted.data.at(1)).toEqual({
      state: "complete",
      toolCallId: "search-1",
      type: "tool-result",
    });
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual(
      parts,
    );
  });

  test("preserves raw arguments only while tool input is partial", () => {
    const part = {
      arguments: '{"query":"nd',
      id: "search-streaming",
      name: "mcp__external__search",
      state: "input-streaming",
      type: "tool-call",
    } as const satisfies ChatPart;

    const persisted = toPersistedChatMessageContentV3({
      data: [part],
    });

    expect(persisted.data).toEqual([
      {
        id: "search-streaming",
        input: { rawArguments: '{"query":"nd', status: "raw" },
        name: "mcp__external__search",
        state: "input-streaming",
        type: "tool-call",
      },
    ]);
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual([
      part,
    ]);
  });

  test("stores paired rich tool output once without flattening its parts", () => {
    const output = [
      { content: "Generated evidence", type: "text" },
      {
        source: {
          mimeType: "image/png",
          type: "url",
          value: "https://example.test/evidence.png",
        },
        type: "image",
      },
      {
        source: {
          mimeType: "audio/mpeg",
          type: "url",
          value: "https://example.test/evidence.mp3",
        },
        type: "audio",
      },
      {
        source: {
          mimeType: "video/mp4",
          type: "url",
          value: "https://example.test/evidence.mp4",
        },
        type: "video",
      },
      {
        source: {
          mimeType: "application/pdf",
          type: "url",
          value: "https://example.test/evidence.pdf",
        },
        type: "document",
      },
    ] satisfies Extract<ChatPart, { type: "tool-result" }>["content"];
    const parts = [
      {
        arguments: "{}",
        id: "rich-output",
        input: {},
        name: "mcp__external__evidence",
        output,
        state: "complete",
        type: "tool-call",
      },
      {
        content: output,
        state: "complete",
        toolCallId: "rich-output",
        type: "tool-result",
      },
    ] as const satisfies ChatPart[];

    const persisted = toPersistedChatMessageContentV3({ data: [...parts] });

    expect(persisted.data.at(1)).toEqual({
      content: { type: "paired-output-parts" },
      state: "complete",
      toolCallId: "rich-output",
      type: "tool-result",
    });
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual(
      parts,
    );
  });

  test("keeps ordinary JSON-array output as textual tool-result content", () => {
    const output = [{ id: "document-1" }];
    const parts = [
      {
        arguments: "{}",
        id: "json-array-output",
        input: {},
        name: "mcp__external__list",
        output,
        state: "complete",
        type: "tool-call",
      },
      {
        content: JSON.stringify(output),
        state: "complete",
        toolCallId: "json-array-output",
        type: "tool-result",
      },
    ] as const satisfies ChatPart[];

    const persisted = toPersistedChatMessageContentV3({ data: [...parts] });

    expect(persisted.data.at(1)).toEqual({
      state: "complete",
      toolCallId: "json-array-output",
      type: "tool-result",
    });
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual(
      parts,
    );
  });

  test("parses old completed tool arguments once at the legacy read boundary", () => {
    const legacy = toChatMessageContent({
      data: [
        {
          arguments: '{"query":"contract"}',
          id: "legacy-search",
          name: "mcp__external__search",
          state: "input-complete",
          type: "tool-call",
        },
      ],
      version: 2,
    });

    expect(normalizePersistedChatMessageContent(legacy).parts).toEqual([
      {
        arguments: '{"query":"contract"}',
        id: "legacy-search",
        input: { query: "contract" },
        name: "mcp__external__search",
        state: "input-complete",
        type: "tool-call",
      },
    ]);
  });

  test("preserves malformed legacy arguments when no parsed input exists", () => {
    const legacy = toChatMessageContent({
      data: [
        {
          arguments: '{"query":',
          id: "legacy-error",
          name: "mcp__external__search",
          output: { error: "Invalid arguments" },
          state: "error",
          type: "tool-call",
        },
      ],
      version: 2,
    });

    expect(normalizePersistedChatMessageContent(legacy).parts).toEqual(
      legacy.data,
    );
  });

  test("preserves unavailable input for a terminal error call", () => {
    const persisted = toPersistedChatMessageContentV3({
      data: [
        {
          arguments: '{"query":',
          id: "failed-input",
          name: "mcp__external__search",
          output: { error: "Invalid arguments" },
          state: "error",
          type: "tool-call",
        },
      ],
    });

    expect(persisted.data.at(0)).toMatchObject({
      id: "failed-input",
      input: { rawArguments: '{"query":', status: "raw" },
      state: "error",
      type: "tool-call",
    });
  });

  test("preserves string result content that differs from canonical output", () => {
    const parts = [
      {
        arguments: "{}",
        id: "formatted-output",
        input: {},
        name: "mcp__external__search",
        output: { value: "canonical" },
        state: "complete",
        type: "tool-call",
      },
      {
        content: "Provider-formatted result",
        state: "complete",
        toolCallId: "formatted-output",
        type: "tool-result",
      },
    ] as const satisfies ChatPart[];

    const persisted = toPersistedChatMessageContentV3({ data: [...parts] });

    expect(persisted.data.at(1)).toEqual({
      content: { type: "text", value: "Provider-formatted result" },
      state: "complete",
      toolCallId: "formatted-output",
      type: "tool-result",
    });
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual(
      parts,
    );
  });

  test("rejects rich result content that disagrees with canonical output", () => {
    expect(() =>
      toPersistedChatMessageContentV3({
        data: [
          {
            arguments: "{}",
            id: "mismatched-output",
            input: {},
            name: "mcp__external__search",
            output: [{ content: "canonical", type: "text" }],
            state: "complete",
            type: "tool-call",
          },
          {
            content: [{ content: "stale", type: "text" }],
            state: "complete",
            toolCallId: "mismatched-output",
            type: "tool-result",
          },
        ],
      }),
    ).toThrow("Tool result mismatched-output disagrees with canonical output");
  });

  test("rejects malformed v3 parsed input at the database boundary", () => {
    const persisted = toPersistedChatMessageContentV3({
      data: [
        {
          arguments: "{}",
          id: "malformed-row",
          input: {},
          name: "mcp__external__search",
          state: "input-complete",
          type: "tool-call",
        },
      ],
    });
    const call = persisted.data.at(0);
    if (call === undefined) {
      return;
    }
    Reflect.set(call, "input", { status: "parsed", value: new Date() });

    expect(() => normalizePersistedChatMessageContent(persisted)).toThrow(
      "Cannot mark an invalid tool input as parsed",
    );
  });

  test("rejects non-JSON canonical tool output", () => {
    expect(() =>
      chatMessageContentFromMessage(
        toPersistableChatMessage({
          id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111112"),
          parts: [
            {
              arguments: "{}",
              id: "invalid-output",
              input: {},
              name: "mcp__external__search",
              output: new Date("2026-01-01T00:00:00.000Z"),
              state: "complete",
              type: "tool-call",
            },
          ],
          role: "assistant",
        }),
      ),
    ).toThrow("Cannot mark an invalid tool output as parsed");
  });

  test("classifies every ask-user tool-call state for turn ownership", () => {
    type ToolCallState = Extract<ChatPart, { type: "tool-call" }>["state"];

    const getInteractionForState = (state: ToolCallState) => {
      const call = {
        arguments: '{"question":"Which jurisdiction applies?"}',
        id: `ask-${state}`,
        name: "ask-user",
        state,
        type: "tool-call",
      } satisfies ChatPart;

      return getAwaitingUserInteraction({
        parts: [call],
        role: "assistant",
      });
    };

    expect({
      "approval-requested": getInteractionForState("approval-requested"),
      "approval-responded": getInteractionForState("approval-responded"),
      "awaiting-input": getInteractionForState("awaiting-input"),
      complete: getInteractionForState("complete"),
      error: getInteractionForState("error"),
      "input-complete": getInteractionForState("input-complete"),
      "input-streaming": getInteractionForState("input-streaming"),
    } satisfies Record<
      ToolCallState,
      ReturnType<typeof getInteractionForState>
    >).toEqual({
      "approval-requested": {
        toolCallId: "ask-approval-requested",
        type: "approval",
      },
      "approval-responded": null,
      "awaiting-input": null,
      complete: null,
      error: null,
      "input-complete": {
        toolCallId: "ask-input-complete",
        type: "ask-user",
      },
      "input-streaming": null,
    } as const satisfies Record<
      ToolCallState,
      ReturnType<typeof getInteractionForState>
    >);
  });

  test("keeps every pending approval actionable", () => {
    const parts = [
      {
        arguments: '{"title":"First"}',
        id: "approval-first",
        name: "create-document",
        state: "approval-requested",
        type: "tool-call",
      },
      {
        arguments: '{"title":"Second"}',
        id: "approval-second",
        name: "create-document",
        state: "approval-requested",
        type: "tool-call",
      },
    ] as const satisfies ChatPart[];

    expect(
      getAwaitingUserInteractions({ parts: [...parts], role: "assistant" }),
    ).toEqual([
      { toolCallId: "approval-first", type: "approval" },
      { toolCallId: "approval-second", type: "approval" },
    ]);
  });

  test("prefers an explicit approval response over an unchanged ask-user call", () => {
    const parts = [
      {
        arguments:
          '{"analysis":"Need jurisdiction","questions":[{"question":"Which court?","reason":"Jurisdiction determines the law."}]}',
        id: "ask-1",
        input: {
          analysis: "Need jurisdiction",
          questions: [
            {
              question: "Which court?",
              reason: "Jurisdiction determines the law.",
            },
          ],
        },
        name: "ask-user",
        state: "input-complete",
        type: "tool-call",
      },
      {
        arguments: '{"name":"Agreement","source":"@title Agreement"}',
        id: "approval-1",
        input: { name: "Agreement", source: "@title Agreement" },
        name: "create-document",
        state: "approval-responded",
        type: "tool-call",
      },
    ] as const satisfies ChatPart[];

    expect(
      getAwaitingUserInteractions({ parts: [...parts], role: "assistant" }),
    ).toEqual([{ toolCallId: "ask-1", type: "ask-user" }]);
    expect(
      getResumedUserInteraction({
        awaited: [
          { toolCallId: "ask-1", type: "ask-user" },
          { toolCallId: "approval-1", type: "approval" },
        ],
        message: { parts: [...parts], role: "assistant" },
      }),
    ).toEqual({ toolCallId: "approval-1", type: "approval" });
  });

  test("awaits a client-executed tool call whose input is complete", () => {
    const parts = [
      {
        arguments: '{"query":"nda"}',
        id: "search-1",
        input: { query: "nda" },
        name: "mcp__external__search",
        output: { matters: [] },
        state: "complete",
        type: "tool-call",
      },
      {
        arguments: '{"name":"NDA","source":"@title NDA"}',
        id: "draft-1",
        input: { name: "NDA", source: "@title NDA" },
        name: "create-document",
        state: "input-complete",
        type: "tool-call",
      },
    ] as const satisfies ChatPart[];

    expect(
      getAwaitingUserInteractions({ parts: [...parts], role: "assistant" }),
    ).toEqual([{ toolCallId: "draft-1", type: "client-tool" }]);
  });

  test("resolves a client-tool interaction only through its awaited call", () => {
    const awaited = [
      { toolCallId: "draft-1", type: "client-tool" },
    ] as const satisfies Parameters<
      typeof getResumedUserInteraction
    >[0]["awaited"];
    const resolvedDraft = {
      arguments: '{"name":"NDA","source":"@title NDA"}',
      id: "draft-1",
      input: { name: "NDA", source: "@title NDA" },
      name: "create-document",
      output: { destination: "draft", fileName: "NDA.docx", success: true },
      state: "complete",
      type: "tool-call",
    } as const satisfies ChatPart;
    // A completed server tool after the awaited call is not an answer.
    const completedServerCall = {
      arguments: '{"query":"nda"}',
      id: "search-1",
      input: { query: "nda" },
      name: "mcp__external__search",
      output: { matters: [] },
      state: "complete",
      type: "tool-call",
    } as const satisfies ChatPart;

    expect(
      getResumedUserInteraction({
        awaited,
        message: {
          parts: [resolvedDraft, completedServerCall],
          role: "assistant",
        },
      }),
    ).toEqual({ toolCallId: "draft-1", type: "client-tool" });
    // A cancelled native resume leaves the awaited call untouched; the turn
    // still names its owner so the execution claim can proceed.
    const { output: _output, ...untouchedDraft } = resolvedDraft;
    expect(
      getResumedUserInteraction({
        awaited,
        message: {
          parts: [{ ...untouchedDraft, state: "input-complete" }],
          role: "assistant",
        },
      }),
    ).toEqual({ toolCallId: "draft-1", type: "client-tool" });
    expect(
      getResumedUserInteraction({
        awaited: [],
        message: { parts: [resolvedDraft], role: "assistant" },
      }),
    ).toBeNull();
  });

  test("persists every structured-output terminal and streaming state", () => {
    const parts = [
      { raw: '{"answer":', status: "streaming", type: "structured-output" },
      {
        data: { answer: 42 },
        raw: '{"answer":42}',
        status: "complete",
        type: "structured-output",
      },
      {
        errorMessage: "Invalid structured output",
        raw: "not-json",
        status: "error",
        type: "structured-output",
      },
    ] as const satisfies ChatPart[];

    expect(
      toPersistableChatMessage({
        id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
        parts: [...parts],
        role: "assistant",
      }).parts,
    ).toEqual(parts);
  });

  test("rejects malformed structured-output states at the persistence boundary", () => {
    const malformedParts = [
      { raw: "{}", status: "future", type: "structured-output" },
      { raw: 42, status: "streaming", type: "structured-output" },
      {
        raw: "{}",
        reasoning: 42,
        status: "streaming",
        type: "structured-output",
      },
      { raw: "{}", status: "complete", type: "structured-output" },
      { raw: "{}", status: "error", type: "structured-output" },
      {
        errorMessage: 42,
        raw: "{}",
        status: "error",
        type: "structured-output",
      },
    ];

    for (const part of malformedParts) {
      // Every fixture keeps type: "structured-output", so persistence
      // rejects each the same way (see the invalidHandling !== "drop" panic).
      expect(() => classifyChatPartForPersistence(part)).toThrow(
        "Cannot persist malformed chat part type: structured-output",
      );
    }
  });

  test("preserves server-owned search-summary provenance", () => {
    const message = chatMessageFromPersisted({
      id: toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda78"),
      role: "assistant",
      content: toChatMessageContent({
        version: 2,
        data: [{ type: "text", content: "Summary" }],
        metadata: {
          serverProvenance: { type: "search-summary", version: 1 },
        },
      }),
    });

    expect(message.metadata).toEqual({
      serverProvenance: { type: "search-summary", version: 1 },
    });
  });

  test("preserves server-owned ref metadata", () => {
    const entityId = toSafeId<"entity">("entity-1");
    const workspaceId = toSafeId<"workspace">("workspace-1");
    const refContext = {
      version: 1 as const,
      entities: [
        {
          entity: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
          toolCallId: "tool-1",
          workspace: resourceRef({
            type: RESOURCE_TYPE.WORKSPACE,
            id: workspaceId,
          }),
        },
      ],
      unresolvedInputs: [],
      workspaceScope: [],
    };
    const message = chatMessageFromPersisted({
      id: toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda80"),
      role: "assistant",
      content: toChatMessageContent({
        version: 2,
        data: [{ type: "text", content: "Summary" }],
        metadata: {
          refContext,
          refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
        },
      }),
    });

    expect(message.metadata).toEqual({
      refContext,
      refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
    });
  });

  test("preserves usage-only metadata", () => {
    const message = chatMessageFromPersisted({
      id: toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda79"),
      role: "assistant",
      content: toChatMessageContent({
        version: 2,
        data: [{ type: "text", content: "Ahoj" }],
        metadata: {
          usage: {
            completionTokens: 20,
            completionTokensDetails: { reasoningTokens: 12 },
            promptTokens: 10,
            totalTokens: 30,
          },
        },
      }),
    });

    expect(message.metadata).toEqual({
      usage: {
        completionTokens: 20,
        completionTokensDetails: { reasoningTokens: 12 },
        promptTokens: 10,
        totalTokens: 30,
      },
    });
  });
});

describe("chat attachment parts", () => {
  test("rejects malformed attachment parts with null source", () => {
    expect(isChatAttachmentPart({ type: "image", source: null })).toBe(false);
  });

  test("persists rich output without accepting or replaying it", () => {
    for (const part of richChatParts) {
      expect(isChatPart(part)).toBe(true);
      expect(isIncomingChatPart(part)).toBe(false);
      expect(isProviderVisibleChatPart(part)).toBe(false);
      expect(classifyChatPartForPersistence(part).type).toBe("persist");
    }
  });

  test("persists only canonical rich output fields", () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (metadata, meta) => {
          for (const part of [richChatParts[0], richChatParts[1]]) {
            expect(
              classifyChatPartForPersistence({
                ...part,
                metadata,
                unexpected: meta,
              }),
            ).toEqual({ type: "persist", part });
          }

          const uiResource = richChatParts[2];
          expect(
            classifyChatPartForPersistence({
              ...uiResource,
              meta,
              unexpected: metadata,
              resource: { ...uiResource.resource, unexpected: meta },
            }),
          ).toEqual({
            type: "persist",
            part: { ...uiResource, meta },
          });
        },
      ),
      propertyConfig(),
    );
  });

  test("bounds every mixed rich-part sequence and reaches a fixed point", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 100 }),
        (kinds) => {
          const parts = kinds.map(budgetPropertyPartFromKind);
          const first = applyChatPartPersistenceBudget(parts);
          const second = applyChatPartPersistenceBudget(first.parts);
          const inputText = parts.filter((part) => part.type === "text");
          const outputText = first.parts.filter((part) => part.type === "text");

          expect(outputText).toEqual(inputText);
          expect(first.richPartCount).toBeLessThanOrEqual(
            LIMITS.chatRichPartsPerMessageMax,
          );
          expect(first.richPartBytes).toBeLessThanOrEqual(
            LIMITS.chatRichPartsTotalMaxBytes,
          );
          expect(second.parts).toEqual(first.parts);
          expect(second.droppedPartTypes).toHaveLength(0);
        },
      ),
      propertyConfig(),
    );
  });

  test("drops rich resources after their cumulative byte budget", () => {
    const largeResource = {
      ...richChatParts[2],
      resource: {
        ...richChatParts[2].resource,
        text: "x".repeat(CHAT_RICH_PART_LIMITS.uiResourceContentMaxChars),
      },
    };
    const parts = Array.from({ length: 6 }, () => largeResource);

    const budgeted = applyChatPartPersistenceBudget(parts);

    expect(budgeted.richPartBytes).toBeLessThanOrEqual(
      LIMITS.chatRichPartsTotalMaxBytes,
    );
    expect(budgeted.parts.length).toBeLessThan(parts.length);
    expect(budgeted.droppedPartTypes.length).toBeGreaterThan(0);
  });

  test("restores exactly the persisted server-owned sequence", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 20 }),
        fc.array(fc.integer({ min: 1, max: 3 }), { maxLength: 10 }),
        (persistedKinds, forgedKinds) => {
          const persistedParts = persistedKinds.map(budgetPropertyPartFromKind);
          const incomingParts: ChatPart[] = persistedParts.filter(
            (part) => !isServerOwnedChatPart(part),
          );
          incomingParts.push(...forgedKinds.map(budgetPropertyPartFromKind));

          expect(
            restoreServerOwnedChatParts({ incomingParts, persistedParts }),
          ).toEqual(persistedParts);
        },
      ),
      propertyConfig(),
    );
  });

  test("rejects unsafe rich output shapes", () => {
    expect(
      isChatPart({
        type: "audio",
        source: { type: "data", value: "Zm9v" },
      }),
    ).toBe(false);
    expect(
      isChatPart({
        type: "audio",
        source: { type: "data", value: "A=", mimeType: "audio/mpeg" },
      }),
    ).toBe(false);
    expect(
      isChatPart({
        type: "video",
        source: {
          type: "url",
          value: unsafeScriptUrl,
          mimeType: "video/mp4",
        },
      }),
    ).toBe(false);
    expect(
      isChatPart({
        type: "ui-resource",
        resource: {
          uri: "ui://widget",
          mimeType: "text/html",
          text: "<p>Widget</p>",
        },
        toolCallId: "call-1",
        toolName: "widget",
      }),
    ).toBe(false);
    expect(
      isChatPart({
        type: "ui-resource",
        resource: {
          uri: "ui://widget",
          mimeType: "text/html;profile=mcp-app",
          text: "",
        },
        toolCallId: "call-1",
        toolName: "widget",
      }),
    ).toBe(false);
    expect(
      isChatPart({
        ...richChatParts[2],
        meta: {
          oversized: "x".repeat(LIMITS.chatRichPartsTotalMaxBytes),
        },
      }),
    ).toBe(false);
  });

  test("fails loudly for malformed parts whose type must be persisted", () => {
    expect(() =>
      classifyChatPartForPersistence({ type: "tool-call", state: "new-state" }),
    ).toThrow("Cannot persist malformed chat part type: tool-call");
  });

  test("persists a tool call that ended in a recoverable execution error", () => {
    const part = {
      type: "tool-call" as const,
      id: "call-1",
      name: "load-skill",
      arguments: JSON.stringify({ skillName: "missing-skill" }),
      state: "error" as const,
    } satisfies ChatPart;

    expect(classifyChatPartForPersistence(part)).toEqual({
      type: "persist",
      part,
    });
  });
});
