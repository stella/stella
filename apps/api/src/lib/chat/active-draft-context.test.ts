import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  canUseChatThreadForGeneratedDocumentDraft,
  createGeneratedDocumentActiveDraftContext,
} from "./active-draft-context";

const generatedDraft = {
  originChatMessageId: toSafeId<"chatMessage">("draft-message"),
  originChatThreadId: toSafeId<"chatThread">("origin-thread"),
  toolCallId: "create-document-1",
};

describe("generated document draft chat binding", () => {
  test("accepts only the exact server-stamped draft identity", () => {
    const activeDraftContext =
      createGeneratedDocumentActiveDraftContext(generatedDraft);

    expect(activeDraftContext).toEqual({
      type: "generated-document",
      ...generatedDraft,
      version: 1,
    });
    expect(
      createGeneratedDocumentActiveDraftContext({
        ...generatedDraft,
        toolCallId: "different-create-document",
      }),
    ).not.toEqual(activeDraftContext);
  });

  test("rejects a chat with history that does not bind the draft", () => {
    expect(
      canUseChatThreadForGeneratedDocumentDraft({
        firstSend: false,
        hasPersistedContext: false,
      }),
    ).toBe(false);
    expect(
      canUseChatThreadForGeneratedDocumentDraft({
        firstSend: false,
        hasPersistedContext: true,
      }),
    ).toBe(true);
  });

  test("accepts the send that writes a chat's first message", () => {
    expect(
      canUseChatThreadForGeneratedDocumentDraft({
        firstSend: true,
        hasPersistedContext: false,
      }),
    ).toBe(true);
  });
});
