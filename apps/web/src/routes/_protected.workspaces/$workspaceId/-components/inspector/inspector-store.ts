import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import { usePdfStore } from "@/lib/pdf/pdf-store";

import { usePeekStore } from "../peek/peek-store";

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
  /** Incrementing sequence to trigger re-activation
   *  effects (e.g. scroll to page) when re-opening. */
  activationSeq: number;
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
};

type Actions = {
  openPdf: (tab: Omit<PdfTab, "type" | "activationSeq">) => void;
  openTask: (taskId: string, label: string, isNew?: boolean) => void;
  closeTab: (id: string) => void;
  closeAll: () => void;
  setActive: (id: string) => void;
  clearTaskNewFlag: (taskId: string) => void;
};

export const useInspectorStore = create<State & Actions>()(
  immer((set) => ({
    tabs: [],
    activeId: null,

    openPdf: (tab) => {
      usePeekStore.getState().closeAll();
      set((state) => {
        const existing = state.tabs.find((t) => t.id === tab.id);
        if (!existing) {
          state.tabs.push({
            type: "pdf",
            ...tab,
            activationSeq: 1,
          });
        } else if (existing.type === "pdf") {
          existing.justificationFieldId = tab.justificationFieldId;
          existing.propertyId = tab.propertyId;
          existing.entityId = tab.entityId;
          existing.workspaceId = tab.workspaceId;
          // Preserve the original PDF filename; only accept a new label
          // when the tab does not yet have one or it was a fallback ID.
          const isFallbackId = existing.label === existing.id;
          if (tab.label && (!existing.label || isFallbackId)) {
            existing.label = tab.label;
          }
          // Only overwrite mimeType when the caller supplies one;
          // clearing it on re-open would drop a previously set value.
          if (tab.mimeType !== undefined) {
            existing.mimeType = tab.mimeType;
          }
          existing.activationSeq += 1;
        }
        state.activeId = tab.id;
      });
    },

    openTask: (taskId, label, isNew) => {
      usePeekStore.getState().closeAll();
      set((state) => {
        const existing = state.tabs.find((t) => t.id === taskId);
        if (!existing) {
          state.tabs.push({
            type: "task",
            id: taskId,
            label: label ?? "",
            isNew: isNew ?? false,
          });
        } else if (existing.type === "task") {
          existing.label = label;
          if (isNew !== undefined) {
            existing.isNew = isNew;
          }
        }
        state.activeId = taskId;
      });
    },

    closeTab: (id) => {
      const tabToClose = useInspectorStore
        .getState()
        .tabs.find((t) => t.id === id);

      set((state) => {
        const idx = state.tabs.findIndex((t) => t.id === id);
        if (idx === -1) {
          return;
        }

        state.tabs.splice(idx, 1);

        if (state.activeId === id) {
          const next = state.tabs[idx] ?? state.tabs[idx - 1];
          state.activeId = next?.id ?? null;
        }
      });

      if (tabToClose?.type === "pdf") {
        usePdfStore
          .getState()
          .cleanupPdf(tabToClose.id)
          .catch(() => {
            /* fire-and-forget cleanup */
          });
      }
    },

    setActive: (id) =>
      set((state) => {
        state.activeId = id;
      }),

    closeAll: () => {
      const pdfIds = useInspectorStore
        .getState()
        .tabs.filter((t) => t.type === "pdf")
        .map((t) => t.id);

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
