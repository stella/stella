import type { UIMessage } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_RICH_PART_LIMITS,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";
import { propertyConfig } from "@stll/property-testing";

import { richChatParts, unsafeScriptUrl } from "./__fixtures__/rich-chat-parts";
import {
  applyChatPartPersistenceBudget,
  isChatPart,
} from "./chat-message-parts";
import { toChatMessage } from "./stream-chat";

const invalidRichChatParts = [
  {
    type: "audio",
    source: {
      type: "url",
      value: unsafeScriptUrl,
      mimeType: "audio/mpeg",
    },
  },
  {
    type: "video",
    source: {
      type: "url",
      value: unsafeScriptUrl,
      mimeType: "video/mp4",
    },
  },
  {
    type: "ui-resource",
    resource: {
      uri: "ui://oversized",
      mimeType: MCP_APP_RESOURCE_MIME_TYPE,
      text: "x".repeat(CHAT_RICH_PART_LIMITS.uiResourceContentMaxChars + 1),
    },
    toolCallId: "call-oversized",
    toolName: "oversized",
  },
] as const;

const streamedPartFromKind = (kind: number): UIMessage["parts"][number] => {
  switch (kind) {
    case 1:
      return richChatParts[0];
    case 2:
      return richChatParts[1];
    case 3:
      return richChatParts[2];
    case 4:
      return invalidRichChatParts[0];
    case 5:
      return invalidRichChatParts[1];
    case 6:
      return invalidRichChatParts[2];
    default:
      return { type: "text", content: String(kind) };
  }
};

describe("streamed chat message conversion invariants", () => {
  test("preserves every valid streamed part and drops invalid rich output", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 20 }),
        (kinds) => {
          const parts = kinds.map(streamedPartFromKind);
          const expectedParts = applyChatPartPersistenceBudget(
            parts.filter(isChatPart),
          ).parts;
          const message = toChatMessage({
            id: "assistant-message",
            role: "assistant",
            parts,
          });

          if (expectedParts.length === 0) {
            expect(message).toBeNull();
            return;
          }
          expect(message?.parts).toEqual(expectedParts);
        },
      ),
      propertyConfig(),
    );
  });
});
