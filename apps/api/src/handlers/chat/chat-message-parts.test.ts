import type { ToolCallState } from "@tanstack/ai-client";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_RICH_PART_LIMITS } from "@stll/api-contract";
import { propertyConfig } from "@stll/property-testing";

import {
  applyChatPartPersistenceBudget,
  chatMessageFromPersisted,
  classifyChatPartForPersistence,
  createChatTextPart,
  isIncomingChatPart,
  isChatAttachmentPart,
  isChatPart,
  isProviderVisibleChatPart,
  isServerOwnedChatPart,
  restoreServerOwnedChatParts,
  toChatMessageContent,
  toPersistableChatMessage,
  getAwaitingUserInteraction,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
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
  test("gives ask-user turn ownership only after its input is complete", () => {
    const askUserCallsByState = {
      "approval-requested": {
        arguments: "{}",
        id: "ask-approval-requested",
        name: "ask-user",
        state: "approval-requested",
        type: "tool-call",
      },
      "approval-responded": {
        arguments: "{}",
        id: "ask-approval-responded",
        name: "ask-user",
        state: "approval-responded",
        type: "tool-call",
      },
      "awaiting-input": {
        arguments: "",
        id: "ask-awaiting-input",
        name: "ask-user",
        state: "awaiting-input",
        type: "tool-call",
      },
      complete: {
        arguments: "{}",
        id: "ask-complete",
        name: "ask-user",
        state: "complete",
        type: "tool-call",
      },
      error: {
        arguments: "{}",
        id: "ask-error",
        name: "ask-user",
        state: "error",
        type: "tool-call",
      },
      "input-complete": {
        arguments: '{"question":"Which jurisdiction applies?"}',
        id: "ask-input-complete",
        name: "ask-user",
        state: "input-complete",
        type: "tool-call",
      },
      "input-streaming": {
        arguments: '{"question":"Which',
        id: "ask-input-streaming",
        name: "ask-user",
        state: "input-streaming",
        type: "tool-call",
      },
    } as const satisfies Record<
      ToolCallState,
      Extract<ChatPart, { type: "tool-call" }>
    >;

    for (const call of Object.values(askUserCallsByState)) {
      let expectedInteraction:
        | { type: "approval"; toolCallId: string }
        | { type: "ask-user"; toolCallId: string }
        | null;
      if (call.state === "approval-requested") {
        expectedInteraction = { type: "approval", toolCallId: call.id };
      } else if (call.state === "input-complete") {
        expectedInteraction = { type: "ask-user", toolCallId: call.id };
      } else {
        expectedInteraction = null;
      }
      expect(
        getAwaitingUserInteraction({ parts: [call], role: "assistant" }),
      ).toEqual(expectedInteraction);
    }
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
      expect(() => classifyChatPartForPersistence(part)).toThrow();
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
