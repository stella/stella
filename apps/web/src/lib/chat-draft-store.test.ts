import type { JSONContent } from "@tiptap/react";
import { afterEach, describe, expect, test } from "bun:test";

import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import {
  appendMentionToDraftDoc,
  areDraftDocsEqual,
  createChatDraftState,
  createEmptyChatDraftDoc,
  nextDraftForEditorUpdate,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { getChatThreadKey, toChatThreadId } from "@/lib/chat-thread-ref";

const docWithText = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

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

describe("areDraftDocsEqual", () => {
  test("compares by value, not reference", () => {
    expect(
      areDraftDocsEqual(createEmptyChatDraftDoc(), createEmptyChatDraftDoc()),
    ).toBe(true);
    expect(areDraftDocsEqual(docWithText("a"), docWithText("b"))).toBe(false);
  });
});

describe("nextDraftForEditorUpdate", () => {
  // Regression guard: tiptap emits `update` for transactions that leave the
  // document unchanged (e.g. while the page re-renders during response
  // streaming). Returning a fresh draft for those no-op updates churned the
  // store reference and looped the editor's onUpdate until React threw
  // "Maximum update depth exceeded". A no-op update must yield null.
  test("returns null when the document is unchanged (distinct but equal docs)", () => {
    const result = nextDraftForEditorUpdate({
      attachments: [],
      nextDoc: createEmptyChatDraftDoc(),
      storedDoc: createEmptyChatDraftDoc(),
    });

    expect(result).toBeNull();
  });

  test("returns a new draft state carrying the edited doc and attachments", () => {
    const attachments: ChatDraftAttachment[] = [
      {
        file: new File(["x"], "a.pdf", { type: "application/pdf" }),
        filename: "a.pdf",
        id: "att-1",
        mimeType: "application/pdf",
      },
    ];
    const nextDoc = docWithText("hello");

    const result = nextDraftForEditorUpdate({
      attachments,
      nextDoc,
      storedDoc: createEmptyChatDraftDoc(),
    });

    expect(result).not.toBeNull();
    expect(result?.doc).toEqual(nextDoc);
    expect(result?.attachments).toBe(attachments);
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
