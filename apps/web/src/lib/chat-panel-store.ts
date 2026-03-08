/**
 * Tiny store for requesting the right panel chat to open
 * with a pre-filled @mention. Any component (row actions,
 * context menus) can call `requestChatAbout` to open the
 * panel and mention an entity.
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
  pendingMention: PendingMention | null;
  /** Incremented on each request so the panel can detect
   *  new requests even for the same entity. */
  requestSeq: number;
  requestChatAbout: (mention: PendingMention) => void;
  consumeMention: () => PendingMention | null;
};

export const useChatPanelStore = create<ChatPanelStore>((set, get) => ({
  pendingMention: null,
  requestSeq: 0,
  requestChatAbout: (mention) =>
    set({
      pendingMention: mention,
      requestSeq: get().requestSeq + 1,
    }),
  consumeMention: () => {
    const mention = get().pendingMention;
    set({ pendingMention: null });
    return mention;
  },
}));
