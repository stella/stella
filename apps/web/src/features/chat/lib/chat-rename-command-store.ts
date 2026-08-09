import { create } from "zustand";

export type ChatRenameRequest = {
  threadId: string;
  /**
   * Title to commit directly (`/rename-chat <title>`); null means open the
   * rename editor with a suggestion instead.
   */
  title: string | null;
};

/**
 * Carries the `/rename-chat` command from a composer to the surface that
 * owns the thread's rename editor (breadcrumb on the chat route, title
 * slot on the file-chat overlay card). Mirrors the inspector command
 * store's `pendingRenameTabId` pattern: the request survives until a
 * mounted consumer for that thread acknowledges it.
 */
type ChatRenameCommandStore = {
  pendingRename: ChatRenameRequest | null;
  requestRename: (request: ChatRenameRequest) => void;
  clearRenameRequest: () => void;
};

export const useChatRenameCommandStore = create<ChatRenameCommandStore>()(
  (set) => ({
    pendingRename: null,
    requestRename: (request) => set({ pendingRename: request }),
    clearRenameRequest: () => set({ pendingRename: null }),
  }),
);
