import { describe, expect, test } from "bun:test";

import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";
import { isReadyGeneratedDocumentDraft } from "@/api/lib/chat/created-draft";

const messageId = toSafeId<"chatMessage">(
  "019fc8e2-dc58-7a48-94cb-40ff5e1f53ed",
);
const message = toPersistableChatMessage({
  id: messageId,
  role: "assistant",
  parts: [
    {
      arguments: JSON.stringify({ name: "Power of attorney", source: "@doc" }),
      id: "tool-create-document-1",
      input: { name: "Power of attorney", source: "@doc" },
      name: "create-document",
      output: {
        destination: "draft",
        fileName: "Power of attorney.docx",
        success: true,
      },
      state: "complete",
      type: "tool-call",
    },
  ],
});
const persisted = {
  content: chatMessageContentFromMessage(message),
  id: messageId,
  role: "assistant" as const,
};

describe("generated document draft boundary", () => {
  test("accepts only the server-persisted tool id and file name", () => {
    expect(
      isReadyGeneratedDocumentDraft({
        content: persisted,
        fileName: "Power of attorney.docx",
        toolCallId: "tool-create-document-1",
      }),
    ).toBe(true);
    expect(
      isReadyGeneratedDocumentDraft({
        content: persisted,
        fileName: "Other.docx",
        toolCallId: "tool-create-document-1",
      }),
    ).toBe(false);
    expect(
      isReadyGeneratedDocumentDraft({
        content: persisted,
        fileName: "Power of attorney.docx",
        toolCallId: "invented-tool",
      }),
    ).toBe(false);
  });
});
