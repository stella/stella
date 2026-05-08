import { afterEach, describe, expect, test } from "bun:test";

import type { ChatMentionOption } from "@/components/chat-mention-extension";
import {
  appendMentionToDraftDoc,
  createChatDraftState,
  createEmptyChatDraftDoc,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { getChatThreadKey, toChatThreadId } from "@/lib/chat-thread-ref";

const mention: ChatMentionOption = {
  id: "entity-1",
  label: "Draft contract",
  category: "entity",
  kind: "document",
  mimeType: "application/pdf",
};

afterEach(() => {
  useChatDraftStore.setState({ draftsByThreadKey: {} });
});

describe("appendMentionToDraftDoc", () => {
  test("appends a mention node to the trailing paragraph", () => {
    const nextDoc = appendMentionToDraftDoc(createEmptyChatDraftDoc(), mention);

    expect(nextDoc.content).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "mention",
            attrs: {
              id: "entity-1",
              label: "Draft contract",
              category: "entity",
              kind: "document",
              mimeType: "application/pdf",
              sourceWorkspaceId: undefined,
            },
          },
          {
            type: "text",
            text: " ",
          },
        ],
      },
    ]);
  });
});

describe("useChatDraftStore", () => {
  test("keeps drafts isolated by normalized thread key", () => {
    const threadId = toChatThreadId("thread-1");
    const globalThreadKey = getChatThreadKey({
      scope: "global",
      threadId,
    });
    const workspaceThreadKey = getChatThreadKey({
      scope: "workspace",
      threadId,
      workspaceId: "workspace-1",
    });

    useChatDraftStore
      .getState()
      .setDraft(globalThreadKey, createChatDraftState());
    useChatDraftStore.getState().insertMention(workspaceThreadKey, mention);

    expect(useChatDraftStore.getState().getDraft(globalThreadKey)?.doc).toEqual(
      createEmptyChatDraftDoc(),
    );
    expect(
      useChatDraftStore
        .getState()
        .getDraft(workspaceThreadKey)
        ?.doc.content?.at(0),
    ).toEqual({
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: {
            id: "entity-1",
            label: "Draft contract",
            category: "entity",
            kind: "document",
            mimeType: "application/pdf",
            sourceWorkspaceId: undefined,
          },
        },
        {
          type: "text",
          text: " ",
        },
      ],
    });
  });
});
