import type {
  ColumnSizingState,
  RowSelectionState,
  Updater,
} from "@tanstack/react-table";
import superjson from "superjson";
import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

const superjsonStorage: PersistStorage<PersistedState> = {
  getItem: (name) => {
    const raw = localStorage.getItem(name);
    if (!raw) {
      return null;
    }
    return superjson.parse(raw);
  },
  setItem: (name, value) => {
    localStorage.setItem(name, superjson.stringify(value));
  },
  removeItem: (name) => {
    localStorage.removeItem(name);
  },
};

type PersistedState = {
  columnSizing: Map<string, ColumnSizingState>;
};

type TableStore = {
  columnSizing: Map<string, ColumnSizingState>;
  setColumnSizing: (
    viewId: string,
    updater: Updater<ColumnSizingState>,
  ) => void;
  rowSelection: Map<string, RowSelectionState>;
  setRowSelection: (
    viewId: string,
    updater: Updater<RowSelectionState>,
  ) => void;
  pruneStaleViews: (activeViewIds: string[]) => void;
};

export const useTableStore = create<TableStore>()(
  persist(
    immer((set) => ({
      columnSizing: new Map<string, ColumnSizingState>(),
      rowSelection: new Map<string, RowSelectionState>(),

      setColumnSizing: (viewId, updater) => {
        set((state) => {
          const prev = state.columnSizing.get(viewId) ?? {};
          const next = typeof updater === "function" ? updater(prev) : updater;
          state.columnSizing.set(viewId, next);
        });
      },

      setRowSelection: (viewId, updater) => {
        set((state) => {
          const prev = state.rowSelection.get(viewId) ?? {};
          const next = typeof updater === "function" ? updater(prev) : updater;
          state.rowSelection.set(viewId, next);
        });
      },

      pruneStaleViews: (activeViewIds) => {
        set((state) => {
          const active = new Set(activeViewIds);
          for (const viewId of state.columnSizing.keys()) {
            if (!active.has(viewId)) {
              state.columnSizing.delete(viewId);
            }
          }
          for (const viewId of state.rowSelection.keys()) {
            if (!active.has(viewId)) {
              state.rowSelection.delete(viewId);
            }
          }
        });
      },
    })),
    {
      name: "stella:table",
      storage: superjsonStorage,
      partialize: (state) => ({
        columnSizing: state.columnSizing,
      }),
    },
  ),
);
