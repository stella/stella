import { v7 as uuidv7 } from "uuid";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type PdfTab = {
  type: "pdf";
  id: string;
  entityId: string;
  /** The PDF filename; preserved across justification slot
   *  navigation so the tab header always shows the file name. */
  label: string;
  mimeType?: string | undefined;
  pdfFileId: string | null;
  /** The workspace this tab belongs to. Used to prevent
   *  cross-workspace state leaks in the chat panel. */
  workspaceId: string;
  /** When set, the inspector shows the justification for
   *  this field alongside the PDF viewer. */
  justificationFieldId?: string | undefined;
  /** The property column that was clicked (for showing
   *  the active cell highlight in the PDF). */
  propertyId?: string | undefined;
};

export type TaskTab = {
  type: "task";
  id: string;
  label: string;
  isNew: boolean;
  status?: string | null;
};

export type ChatTab = {
  type: "chat";
  id: string;
  label: string;
  /**
   * Workspaces this chat draws context from. Defaults to the
   * matter the chat was opened in; users can extend it via the
   * matter picker in the tab header so the AI sees content from
   * additional matters. Phase D will persist this with the Chat
   * record; today it's local to the tab instance.
   */
  contextMatterIds: string[];
  /**
   * Case-law decision the chat was opened *about*. Mirrors the
   * legacy right-panel-chat behaviour where navigating to a
   * decision auto-grounded a fresh chat in that decision's text.
   * Persists on the tab so subsequent renders keep flowing the
   * decision context into the system prompt regardless of the
   * user's current route.
   */
  activeDecisionId?: string | undefined;
};

export type InspectorTab = PdfTab | TaskTab | ChatTab;

type State = {
  tabs: InspectorTab[];
  activeId: string | null;
  /** Increments on every activation; lets the UI flash
   *  a tab that is re-selected (e.g., open same file). */
  activationSeq: number;
  /**
   * One-shot rename request. Set by the rail's right-click menu;
   * the active tab's ribbon reads it, enters edit mode, and clears
   * it. Decouples the rail (which doesn't render the editable
   * label) from the ribbon (which does).
   */
  pendingRenameTabId: string | null;
  /**
   * Collapsed view — the inspector pane is hidden but its tabs
   * are kept. The right-side toggle in the workspace chrome flips
   * this so users can reclaim screen space without losing their
   * open tabs.
   */
  minimized: boolean;
};

type Actions = {
  openPdf: (tab: Omit<PdfTab, "type">) => void;
  openTask: (taskId: string, label?: string, isNew?: boolean) => void;
  /**
   * Open a chat tab. Without args, creates a new (local-only) chat
   * with a generated id. Pass `id` + optional `threadId` to restore
   * an existing thread; pass `contextMatterIds` to seed the chat's
   * matter context (typically the matter the user opened it in).
   */
  openChat: (args?: {
    id?: string;
    label?: string;
    contextMatterIds?: string[];
    activeDecisionId?: string;
  }) => void;
  /**
   * Replace a chat tab's matter context. Used by the matter
   * picker in the tab header so users can extend the AI's view
   * across multiple matters.
   */
  setChatContext: (tabId: string, matterIds: string[]) => void;
  closeTab: (id: string) => void;
  /** Close every tab except the one with the given id. */
  closeOthers: (id: string) => void;
  setActive: (id: string) => void;
  closeAll: () => void;
  /** Ask the active tab's ribbon to start renaming. */
  requestRename: (id: string) => void;
  /** Clear the rename flag once the ribbon has consumed it. */
  clearRenameRequest: () => void;
  clearTaskNewFlag: (taskId: string) => void;
  replacePdfFieldId: (oldFieldId: string, newFieldId: string) => void;
  updateLabel: (tabId: string, label: string) => void;
  updateTaskStatus: (taskId: string, status: string | null) => void;
  /** Set the minimized state directly. */
  setMinimized: (minimized: boolean) => void;
  /** Flip the minimized state (right-side button toggle). */
  toggleMinimized: () => void;
};

export const useInspectorStore = create<State & Actions>()(
  immer((set) => ({
    tabs: [],
    activeId: null,
    activationSeq: 0,
    pendingRenameTabId: null,
    minimized: false,

    openPdf: (tab) =>
      set((state) => {
        const existing = state.tabs.find((t) => t.id === tab.id);
        if (!existing) {
          state.tabs.push({ type: "pdf", ...tab });
        } else if (existing.type === "pdf") {
          existing.justificationFieldId = tab.justificationFieldId;
          existing.propertyId = tab.propertyId;
          existing.entityId = tab.entityId;
          existing.workspaceId = tab.workspaceId;
          const isFallbackId = existing.label === existing.id;
          if (tab.label && (!existing.label || isFallbackId)) {
            existing.label = tab.label;
          }
          if (tab.mimeType !== undefined) {
            existing.mimeType = tab.mimeType;
          }
          if (tab.pdfFileId !== undefined) {
            existing.pdfFileId = tab.pdfFileId;
          }
        }
        state.activeId = tab.id;
        state.activationSeq += 1;
        // Opening a tab while the inspector is collapsed should
        // bring it back into view; otherwise the user's click
        // appears to do nothing.
        state.minimized = false;
      }),

    openTask: (taskId, label = "", isNew = false) =>
      set((state) => {
        const existing = state.tabs.find((t) => t.id === taskId);
        if (!existing) {
          state.tabs.push({
            type: "task",
            id: taskId,
            label,
            isNew,
          });
        } else if (existing.type === "task") {
          if (label) {
            existing.label = label;
          }
          if (isNew) {
            existing.isNew = true;
          }
        }
        state.activeId = taskId;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    openChat: (args = {}) =>
      set((state) => {
        const id = args.id ?? uuidv7();
        const existing = state.tabs.find((t) => t.id === id);
        if (!existing) {
          state.tabs.push({
            type: "chat",
            id,
            label: args.label ?? "New chat",
            contextMatterIds: args.contextMatterIds ?? [],
            activeDecisionId: args.activeDecisionId,
          });
        } else if (existing.type === "chat") {
          if (args.label !== undefined) {
            existing.label = args.label;
          }
          if (args.contextMatterIds !== undefined) {
            existing.contextMatterIds = args.contextMatterIds;
          }
          if (args.activeDecisionId !== undefined) {
            existing.activeDecisionId = args.activeDecisionId;
          }
        }
        state.activeId = id;
        state.activationSeq += 1;
        state.minimized = false;
      }),

    setChatContext: (tabId, matterIds) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (tab?.type === "chat") {
          tab.contextMatterIds = matterIds;
        }
      }),

    closeTab: (id) =>
      set((state) => {
        const index = state.tabs.findIndex((t) => t.id === id);
        if (index === -1) {
          return;
        }

        state.tabs.splice(index, 1);

        if (state.activeId === id) {
          const next = state.tabs[Math.min(index, state.tabs.length - 1)];
          state.activeId = next?.id ?? null;
        }
      }),

    closeOthers: (id) =>
      set((state) => {
        const target = state.tabs.find((t) => t.id === id);
        if (!target) {
          return;
        }
        state.tabs = [target];
        state.activeId = id;
      }),

    setActive: (id) =>
      set((state) => {
        state.activeId = id;
        state.activationSeq += 1;
      }),

    requestRename: (id) =>
      set((state) => {
        state.activeId = id;
        state.activationSeq += 1;
        state.pendingRenameTabId = id;
      }),

    clearRenameRequest: () =>
      set((state) => {
        state.pendingRenameTabId = null;
      }),

    closeAll: () =>
      set((state) => {
        state.tabs = [];
        state.activeId = null;
      }),

    clearTaskNewFlag: (taskId) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === taskId);
        if (tab?.type === "task") {
          tab.isNew = false;
        }
      }),

    replacePdfFieldId: (oldFieldId, newFieldId) =>
      set((state) => {
        const tab = state.tabs.find(
          (t) => t.type === "pdf" && t.id === oldFieldId,
        );
        if (!tab || tab.type !== "pdf") {
          return;
        }

        // Keep the renamed tab, but drop any stale tab already using the target id.
        state.tabs = state.tabs.filter(
          (t) => t.id === oldFieldId || t.id !== newFieldId,
        );
        tab.id = newFieldId;
        if (tab.justificationFieldId === oldFieldId) {
          tab.justificationFieldId = newFieldId;
        }
        if (state.activeId === oldFieldId) {
          state.activeId = newFieldId;
        }
      }),

    updateLabel: (tabId, label) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (tab) {
          tab.label = label;
        }
      }),

    updateTaskStatus: (taskId, status) =>
      set((state) => {
        const tab = state.tabs.find(
          (t) => t.type === "task" && t.id === taskId,
        );
        if (tab && tab.type === "task") {
          tab.status = status;
        }
      }),

    setMinimized: (minimized) =>
      set((state) => {
        state.minimized = minimized;
      }),

    toggleMinimized: () =>
      set((state) => {
        state.minimized = !state.minimized;
      }),
  })),
);
