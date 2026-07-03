import type { JSONContent } from "@tiptap/react";
import { create } from "zustand";

import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";

export type ChatDraftState = {
  attachments: ChatDraftAttachment[];
  doc: JSONContent;
  updatedAt: number;
};

type ChatDraftStore = {
  clearDraft: (threadKey: string) => void;
  draftsByThreadKey: Record<string, ChatDraftState>;
  getDraft: (threadKey: string) => ChatDraftState | null;
  insertMention: (threadKey: string, mention: ChatMentionOption) => void;
  setDraft: (threadKey: string, draft: ChatDraftState) => void;
};

export const createEmptyChatDraftDoc = (): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
    },
  ],
});

const createMentionNode = (mention: ChatMentionOption): JSONContent => ({
  type: "mention",
  attrs: {
    id: mention.id,
    label: mention.label,
    category: mention.category,
    kind: mention.kind,
    mimeType: mention.mimeType,
    sourceWorkspaceId: mention.sourceWorkspaceId,
  },
});

const createTextNode = (text: string): JSONContent => ({
  type: "text",
  text,
});

const appendMentionToParagraph = (
  paragraph: JSONContent,
  mention: ChatMentionOption,
): JSONContent => ({
  ...paragraph,
  content: [
    ...(paragraph.content ?? []),
    createMentionNode(mention),
    createTextNode(" "),
  ],
});

export const appendMentionToDraftDoc = (
  doc: JSONContent,
  mention: ChatMentionOption,
): JSONContent => {
  const content = [...(doc.content ?? [])];
  const lastNode = content.at(-1);

  if (lastNode?.type === "paragraph") {
    content[content.length - 1] = appendMentionToParagraph(lastNode, mention);
    return {
      ...doc,
      content,
    };
  }

  return {
    ...doc,
    content: [
      ...content,
      appendMentionToParagraph({ type: "paragraph" }, mention),
    ],
  };
};

export const createChatDraftState = (
  overrides?: Partial<ChatDraftState>,
): ChatDraftState => ({
  attachments: overrides?.attachments ?? [],
  doc: overrides?.doc ?? createEmptyChatDraftDoc(),
  updatedAt: overrides?.updatedAt ?? Date.now(),
});

export const areDraftDocsEqual = (
  left: JSONContent,
  right: JSONContent,
): boolean => JSON.stringify(left) === JSON.stringify(right);

type NextDraftForEditorUpdateOptions = {
  attachments: ChatDraftAttachment[];
  nextDoc: JSONContent;
  storedDoc: JSONContent;
};

// Decides whether a tiptap `update` event should be persisted to the draft
// store. Returns `null` for no-op updates whose document matches what is
// already stored: tiptap emits `update` even for transactions that leave the
// document unchanged (e.g. editor props re-applied while the page re-renders
// during response streaming). Persisting an identical draft would churn the
// store entry's reference, retrigger the editor's onUpdate, and loop until
// React's max-update-depth guard throws. Only genuine edits yield a new state.
export const nextDraftForEditorUpdate = ({
  attachments,
  nextDoc,
  storedDoc,
}: NextDraftForEditorUpdateOptions): ChatDraftState | null =>
  areDraftDocsEqual(nextDoc, storedDoc)
    ? null
    : createChatDraftState({ attachments, doc: nextDoc });

type ShouldApplyStoredDraftOptions = {
  draftDoc: JSONContent;
  editorAuthoredDraft: boolean;
  editorDoc: JSONContent;
};

// Decides whether the draft-apply sync effect should push a stored draft back
// into the editor via `setContent`. The chat editor owns its own content; the
// draft store only mirrors it. Two invariants make re-applying an
// editor-authored draft actively harmful, so this returns false for any draft
// the editor itself produced:
//
//   1. The sync effect is a passive effect (runs post-paint), so during fast
//      input it lags the live editor: by the time it runs, `editorDoc` (read
//      live) is several keystrokes ahead of the `draftDoc` snapshot the effect
//      closed over. `setContent`-ing that stale snapshot would revert the
//      in-flight keystrokes.
//   2. ProseMirror's DOMObserver can flush a pending DOM mutation as a
//      transaction after the effect's synchronous `isApplyingStoredDraftRef`
//      window has already closed, so a boolean guard cannot bound the churn.
//
// Either way, re-applying editor-authored content loops
// render -> effect -> setContent -> update -> render until React throws
// "Maximum update depth exceeded". Only genuinely external drafts (thread
// switch, restore, a mention inserted while this editor was inactive) are
// applied, and only when they actually differ from the live editor content.
// Because the authored check is identity-based, it is immune to non-idempotent
// `setContent`/`getJSON` roundtrips (split text nodes, dropped default attrs,
// mark ordering) that would make a structural equality check ping-pong.
export const shouldApplyStoredDraftToEditor = ({
  draftDoc,
  editorAuthoredDraft,
  editorDoc,
}: ShouldApplyStoredDraftOptions): boolean => {
  if (editorAuthoredDraft) {
    return false;
  }
  return !areDraftDocsEqual(editorDoc, draftDoc);
};

export const useChatDraftStore = create<ChatDraftStore>((set, get) => ({
  clearDraft: (threadKey) =>
    set((state) => {
      const { [threadKey]: _removed, ...draftsByThreadKey } =
        state.draftsByThreadKey;

      return { draftsByThreadKey };
    }),
  draftsByThreadKey: {},
  getDraft: (threadKey) => get().draftsByThreadKey[threadKey] ?? null,
  insertMention: (threadKey, mention) =>
    set((state) => {
      const currentDraft =
        state.draftsByThreadKey[threadKey] ?? createChatDraftState();

      return {
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [threadKey]: {
            ...currentDraft,
            doc: appendMentionToDraftDoc(currentDraft.doc, mention),
            updatedAt: Date.now(),
          },
        },
      };
    }),
  setDraft: (threadKey, draft) =>
    set((state) => ({
      draftsByThreadKey: {
        ...state.draftsByThreadKey,
        [threadKey]: draft,
      },
    })),
}));

export const getChatDraft = (threadRef: ChatThreadRef): ChatDraftState | null =>
  useChatDraftStore.getState().getDraft(getChatThreadKey(threadRef));

const isEmptyDoc = (draft: ChatDraftState): boolean => {
  if (draft.doc.type !== "doc") {
    return false;
  }
  const nodes = draft.doc.content;
  if (!nodes || nodes.length !== 1) {
    return false;
  }
  const [only] = nodes;
  // A paragraph with children (text, mentions, pasted-text chips) is not empty.
  return only?.type === "paragraph" && (only.content?.length ?? 0) === 0;
};

const isDraftEmpty = (draft: ChatDraftState | null): boolean => {
  if (!draft) {
    return true;
  }
  return draft.attachments.length === 0 && isEmptyDoc(draft);
};

export const isChatDraftEmpty = (threadRef: ChatThreadRef): boolean =>
  isDraftEmpty(getChatDraft(threadRef));

export const useIsChatDraftEmpty = (threadRef: ChatThreadRef): boolean => {
  const threadKey = getChatThreadKey(threadRef);
  return useChatDraftStore((state) =>
    isDraftEmpty(state.draftsByThreadKey[threadKey] ?? null),
  );
};
