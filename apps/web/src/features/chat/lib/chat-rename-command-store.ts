import { create } from "zustand";

/**
 * Carries the `/rename-chat` command from a composer to the surface that
 * owns the thread's rename editor (breadcrumb on the chat route, title
 * slot on the file-chat overlay card). Mirrors the inspector command
 * store's `pendingRenameTabId` pattern: the request survives until a
 * mounted consumer for that thread acknowledges it.
 */
type ChatRenameCommandStore = {
  pendingRenameThreadId: string | null;
  requestRename: (threadId: string) => void;
  clearRenameRequest: () => void;
};

export const useChatRenameCommandStore = create<ChatRenameCommandStore>()(
  (set) => ({
    pendingRenameThreadId: null,
    requestRename: (threadId) => set({ pendingRenameThreadId: threadId }),
    clearRenameRequest: () => set({ pendingRenameThreadId: null }),
  }),
);
