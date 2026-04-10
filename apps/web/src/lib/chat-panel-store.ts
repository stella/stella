import { create } from "zustand";

type ChatPanelStore = {
  globalThreadId: string | null;
  isOpen: boolean;
  open: () => void;
  setGlobalThreadId: (threadId: string | null) => void;
  setOpen: (isOpen: boolean) => void;
  setWorkspaceThreadId: (workspaceId: string, threadId: string | null) => void;
  toggle: () => void;
  workspaceThreadIds: Record<string, string | null>;
};

export const useChatPanelStore = create<ChatPanelStore>((set) => ({
  globalThreadId: null,
  isOpen: false,
  open: () => set({ isOpen: true }),
  setGlobalThreadId: (threadId) => set({ globalThreadId: threadId }),
  setOpen: (isOpen) => set({ isOpen }),
  setWorkspaceThreadId: (workspaceId, threadId) =>
    set((state) => ({
      workspaceThreadIds: {
        ...state.workspaceThreadIds,
        [workspaceId]: threadId,
      },
    })),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  workspaceThreadIds: {},
}));
