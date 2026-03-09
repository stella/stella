/**
 * Tiny store for requesting the right panel chat to open
 * with pre-filled @mentions. Any component (row actions,
 * context menus) can call `requestChatAbout` to open the
 * panel and mention one or more entities.
 */

import { create } from "zustand";

type PendingMention = {
  id: string;
  label: string;
  category: "entity";
  kind: string;
  mimeType: string | null;
  workspaceId: string;
};

type ChatPanelStore = {
  pendingMentions: PendingMention[];
  /** Incremented on each request so the panel can detect
   *  new requests even for the same entity. */
  requestSeq: number;
  requestChatAbout: (mentions: PendingMention | PendingMention[]) => void;
  consumeMentions: () => PendingMention[];
};

export const useChatPanelStore = create<ChatPanelStore>((set, get) => ({
  pendingMentions: [],
  requestSeq: 0,
  requestChatAbout: (mentions) =>
    set({
      pendingMentions: Array.isArray(mentions) ? mentions : [mentions],
      requestSeq: get().requestSeq + 1,
    }),
  consumeMentions: () => {
    const mentions = get().pendingMentions;
    set({ pendingMentions: [] });
    return mentions;
  },
}));
