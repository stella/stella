import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import { usePdfStore } from "@/lib/pdf/pdf-store";

export type PdfTab = {
  type: "pdf";
  id: string;
  entityId: string;
  /** The PDF filename; preserved across justification slot
   *  navigation so the tab header always shows the file name. */
  label: string;
  mimeType?: string;
  /** The workspace this tab belongs to. Used to prevent
   *  cross-workspace state leaks in the chat panel. */
  workspaceId: string;
  /** When set, the inspector shows the justification for
   *  this field alongside the PDF viewer. */
  justificationFieldId?: string;
  /** The property column that was clicked (for showing
   *  the active cell highlight in the PDF). */
  propertyId?: string;
};

export type TaskTab = {
  type: "task";
  id: string;
  label: string;
  isNew: boolean;
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
};

export const useInspectorStore = create<State & Actions>()(
  immer((set, get) => ({
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
          // Preserve the original PDF filename; only accept
          // a new label when the tab does not yet have one
          // or it was a fallback ID.
          const isFallbackId = existing.label === existing.id;
          if (tab.label && (!existing.label || isFallbackId)) {
            existing.label = tab.label;
          }
          // Only overwrite mimeType when the caller supplies
          // one; clearing it on re-open would drop a
          // previously set value.
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

    closeTab: (id) => {
      const tab = get().tabs.find((t) => t.id === id);

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
      });

      if (tab?.type === "pdf") {
        usePdfStore
          .getState()
          .cleanupPdf(id)
          .catch(() => {
            /* fire-and-forget cleanup */
          });
      }
    },

    setActive: (id) =>
      set((state) => {
        state.activeId = id;
        state.activationSeq += 1;
      }),

    closeAll: () => {
      const tabs = get().tabs;
      const pdfIds = tabs.filter((t) => t.type === "pdf").map((t) => t.id);

      set((state) => {
        state.tabs = [];
        state.activeId = null;
      });

      const pdfStore = usePdfStore.getState();
      for (const id of pdfIds) {
        pdfStore.cleanupPdf(id).catch(() => {
          /* fire-and-forget cleanup */
        });
      }
    },

    clearTaskNewFlag: (taskId) =>
      set((state) => {
        const tab = state.tabs.find((t) => t.id === taskId);
        if (tab?.type === "task") {
          tab.isNew = false;
        }
      }),
  })),
);
