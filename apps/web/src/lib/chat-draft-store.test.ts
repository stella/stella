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
  shouldApplyStoredDraftToEditor,
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

describe("shouldApplyStoredDraftToEditor", () => {
  // Regression guard for the "Maximum update depth exceeded" loop that
  // returned via the DOM-mutation (`readDOMChange`) path during fast typing.
  // The draft-apply effect runs post-paint, so it lags the live editor: it
  // closes over an old `draftDoc` snapshot while `editorDoc` (read live) is
  // already several keystrokes ahead. Re-applying that editor-authored
  // snapshot would `setContent` the editor back to stale content, drop the
  // in-flight keystrokes, and thrash. An editor-authored draft must never be
  // applied, even when it differs structurally from the live editor doc.
  test("never re-applies an editor-authored draft, even when it differs", () => {
    expect(
      shouldApplyStoredDraftToEditor({
        draftDoc: docWithText("stale"),
        editorAuthoredDraft: true,
        editorDoc: docWithText("live and ahead"),
      }),
    ).toBe(false);
  });

  // A non-idempotent `setContent`/`getJSON` roundtrip (split text nodes here;
  // the same class covers dropped default attrs and mark reordering) makes two
  // semantically-equal docs compare unequal by value. Because the
  // editor-authored check is identity-based, such drift can never ping-pong.
  test("ignores structural roundtrip drift for editor-authored drafts", () => {
    const splitTextDoc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    };
    const mergedTextDoc = docWithText("ab");

    // The two docs are semantically identical but not JSON-equal.
    expect(areDraftDocsEqual(splitTextDoc, mergedTextDoc)).toBe(false);
    expect(
      shouldApplyStoredDraftToEditor({
        draftDoc: splitTextDoc,
        editorAuthoredDraft: true,
        editorDoc: mergedTextDoc,
      }),
    ).toBe(false);
  });

  test("applies an external draft that differs from the live editor doc", () => {
    // Thread switch / restore: the store holds content this editor did not
    // author *under the current thread*, so it must be pushed into the editor.
    // A draft the editor authored in a prior thread also reaches the helper as
    // `editorAuthoredDraft: false`, because the provider resets its per-thread
    // authored-doc WeakSet on every thread switch; that ref lifecycle lives in
    // chat-editor-provider and is not reproducible in this pure-logic test.
    expect(
      shouldApplyStoredDraftToEditor({
        draftDoc: docWithText("restored"),
        editorAuthoredDraft: false,
        editorDoc: createEmptyChatDraftDoc(),
      }),
    ).toBe(true);
  });

  test("skips an external draft already matching the live editor doc", () => {
    // e.g. an attachments-only change stores the editor's current doc verbatim;
    // no `setContent` should run.
    expect(
      shouldApplyStoredDraftToEditor({
        draftDoc: docWithText("same"),
        editorAuthoredDraft: false,
        editorDoc: docWithText("same"),
      }),
    ).toBe(false);
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
