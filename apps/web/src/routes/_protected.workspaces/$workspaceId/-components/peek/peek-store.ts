import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import { usePdfStore } from "@/lib/pdf/pdf-store";

export type PeekTab = {
  fieldId: string;
  entityId: string;
  label: string;
};

type State = {
  tabs: PeekTab[];
  activeFieldId: string | null;
};

type Actions = {
  openTab: (tab: PeekTab) => void;
  closeTab: (fieldId: string) => void;
  setActive: (fieldId: string) => void;
  closeAll: () => void;
};

export const usePeekStore = create<State & Actions>()(
  immer((set, get) => ({
    tabs: [],
    activeFieldId: null,

    openTab: (tab) =>
      set((state) => {
        const existing = state.tabs.find((t) => t.fieldId === tab.fieldId);

        if (!existing) {
          state.tabs.push(tab);
        }

        state.activeFieldId = tab.fieldId;
      }),

    closeTab: (fieldId) => {
      set((state) => {
        const index = state.tabs.findIndex((t) => t.fieldId === fieldId);

        if (index === -1) {
          return;
        }

        state.tabs.splice(index, 1);

        if (state.activeFieldId === fieldId) {
          const nextTab = state.tabs[Math.min(index, state.tabs.length - 1)];
          state.activeFieldId = nextTab?.fieldId ?? null;
        }
      });

      // Release PDF resources outside the immer producer
      usePdfStore.getState().cleanupPdf(fieldId);
    },

    setActive: (fieldId) =>
      set((state) => {
        state.activeFieldId = fieldId;
      }),

    closeAll: () => {
      const fieldIds = get().tabs.map((t) => t.fieldId);

      set((state) => {
        state.tabs = [];
        state.activeFieldId = null;
      });

      const pdfStore = usePdfStore.getState();
      for (const fieldId of fieldIds) {
        pdfStore.cleanupPdf(fieldId);
      }
    },
  })),
);
