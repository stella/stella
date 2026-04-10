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
