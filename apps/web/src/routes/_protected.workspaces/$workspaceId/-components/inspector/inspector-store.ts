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

export type InspectorTab = PdfTab | TaskTab;

type State = {
  tabs: InspectorTab[];
  activeId: string | null;
  /** Increments on every activation; lets the UI flash
   *  a tab that is re-selected (e.g., open same file). */
  activationSeq: number;
};

type Actions = {
  openPdf: (tab: Omit<PdfTab, "type">) => void;
  openTask: (taskId: string, label?: string, isNew?: boolean) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  closeAll: () => void;
  clearTaskNewFlag: (taskId: string) => void;
  updateLabel: (tabId: string, label: string) => void;
  updateTaskStatus: (taskId: string, status: string | null) => void;
};

export const useInspectorStore = create<State & Actions>()(
  immer((set) => ({
    tabs: [],
    activeId: null,
    activationSeq: 0,

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
        }
        state.activeId = tab.id;
        state.activationSeq += 1;
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

    setActive: (id) =>
      set((state) => {
        state.activeId = id;
        state.activationSeq += 1;
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
  })),
);
