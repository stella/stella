import { describe, expect, test } from "bun:test";

import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";
import {
  getGeneratedDocumentDraftState,
  isReadyGeneratedDocumentDraft,
} from "@/api/lib/chat/created-draft";

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
        persistedContent: persisted.content,
        fileName: "Power of attorney.docx",
        toolCallId: "tool-create-document-1",
      }),
    ).toBe(true);
    expect(
      isReadyGeneratedDocumentDraft({
        persistedContent: persisted.content,
        fileName: "Other.docx",
        toolCallId: "tool-create-document-1",
      }),
    ).toBe(false);
    expect(
      isReadyGeneratedDocumentDraft({
        persistedContent: persisted.content,
        fileName: "Power of attorney.docx",
        toolCallId: "invented-tool",
      }),
    ).toBe(false);
  });

  test("distinguishes a ready draft from its atomically saved replay", () => {
    expect(
      getGeneratedDocumentDraftState({
        persistedContent: persisted.content,
        fileName: "Power of attorney.docx",
        toolCallId: "tool-create-document-1",
      }),
    ).toEqual({
      locator: { partIndex: 0, persistenceVersion: 3 },
      status: "ready",
    });

    const savedMessage = toPersistableChatMessage({
      id: messageId,
      role: "assistant",
      parts: [
        {
          arguments: JSON.stringify({
            name: "Power of attorney",
            source: "@doc",
          }),
          id: "tool-create-document-1",
          input: { name: "Power of attorney", source: "@doc" },
          name: "create-document",
          output: {
            entityId: "entity-1",
            entityRef: "entity-1",
            fieldId: "field-1",
            fileName: "Power of attorney.docx",
            href: "#stella-entity=workspace-1:entity-1",
            matterRef: "workspace-1",
            mention:
              "[Power of attorney.docx](#stella-entity=workspace-1:entity-1)",
            success: true,
            workspaceId: "workspace-1",
          },
          state: "complete",
          type: "tool-call",
        },
      ],
    });
    expect(
      getGeneratedDocumentDraftState({
        persistedContent: chatMessageContentFromMessage(savedMessage),
        fileName: "Power of attorney.docx",
        toolCallId: "tool-create-document-1",
      }),
    ).toMatchObject({
      output: { entityId: "entity-1", fieldId: "field-1" },
      status: "saved",
    });
  });

  test("rejects legacy or malformed persisted content", () => {
    expect(
      getGeneratedDocumentDraftState({
        persistedContent: { data: [], version: 1 },
        fileName: "Power of attorney.docx",
        toolCallId: "tool-create-document-1",
      }),
    ).toEqual({ status: "invalid" });
  });
});
