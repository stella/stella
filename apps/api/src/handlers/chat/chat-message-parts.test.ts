import { describe, expect, test } from "bun:test";

import {
  chatMessageFromPersisted,
  classifyChatPartForPersistence,
  isChatAttachmentPart,
  isChatPart,
  toChatMessageContent,
} from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";

describe("persisted chat message parts", () => {
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

  test("rejects unvalidated audio and video content parts", () => {
    const source = {
      type: "url",
      value: "stella://file::file_test123",
      mimeType: "audio/mpeg",
    };

    expect(isChatPart({ type: "audio", source })).toBe(false);
    expect(isChatPart({ type: "video", source })).toBe(false);
  });

  test("fails loudly for malformed parts whose type must be persisted", () => {
    expect(() =>
      classifyChatPartForPersistence({ type: "tool-call", state: "new-state" }),
    ).toThrow("Cannot persist malformed chat part type: tool-call");
  });
});
