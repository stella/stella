import { create } from "zustand";

type ChatPanelStore = {
  decisionThreadIds: Record<string, string | null>;
  globalThreadId: string | null;
  isOpen: boolean;
  open: () => void;
  setDecisionThreadId: (decisionId: string, threadId: string | null) => void;
  setGlobalThreadId: (threadId: string | null) => void;
  setOpen: (isOpen: boolean) => void;
  setWorkspaceThreadId: (workspaceId: string, threadId: string | null) => void;
  toggle: () => void;
  workspaceThreadIds: Record<string, string | null>;
};

export const useChatPanelStore = create<ChatPanelStore>((set) => ({
  decisionThreadIds: {},
  globalThreadId: null,
  isOpen: false,
  open: () => set({ isOpen: true }),
  setDecisionThreadId: (decisionId, threadId) =>
    set((state) => ({
      decisionThreadIds: {
        ...state.decisionThreadIds,
        [decisionId]: threadId,
      },
    })),
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
