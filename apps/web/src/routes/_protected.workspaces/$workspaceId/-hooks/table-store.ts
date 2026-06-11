import type {
  ColumnSizingState,
  RowSelectionState,
  Updater,
} from "@tanstack/react-table";
import * as v from "valibot";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import type { WorkspaceEntity } from "@/lib/types";

const MAP_TAG = "__map";
const TABLE_CONTENT_MODES = ["tight", "fit-content"] as const;

export type TableContentMode = (typeof TABLE_CONTENT_MODES)[number];

const selectedEntitiesEqual = (
  prev: readonly WorkspaceEntity[] | undefined,
  next: readonly WorkspaceEntity[],
): boolean => {
  if (!prev) {
    return next.length === 0;
  }

  if (prev.length !== next.length) {
    return false;
  }

  return prev.every((entity, index) => {
    const nextEntity = next[index];
    return entity === nextEntity && entity.entityId === nextEntity.entityId;
  });
};

const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) {
    return { [MAP_TAG]: [...value.entries()] };
  }
  return value;
};

type PersistedState = {
  columnSizing: Map<string, ColumnSizingState>;
  contentMode: Record<string, TableContentMode>;
};

const StorageSchema = v.strictObject({
  state: v.strictObject({
    columnSizing: v.strictObject({
      [MAP_TAG]: v.array(
        v.tuple([v.string(), v.record(v.string(), v.number())]),
      ),
    }),
    contentMode: v.optional(
      v.record(v.string(), v.picklist(TABLE_CONTENT_MODES)),
    ),
    columnWidthMode: v.optional(
      v.record(v.string(), v.picklist(TABLE_CONTENT_MODES)),
    ),
  }),
  version: v.optional(v.number(), 0),
});
const parseStorage = v.safeParser(StorageSchema);

const parsePersistedStorage = (
  json: string,
): StorageValue<PersistedState> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = parseStorage(parsed);
  if (!result.success) {
    return null;
  }
  const entries = result.output.state.columnSizing[MAP_TAG];
  const columnSizing = new Map<string, ColumnSizingState>(entries);
  return {
    state: {
      columnSizing,
      contentMode:
        result.output.state.contentMode ??
        result.output.state.columnWidthMode ??
        {},
    },
    version: result.output.version,
  };
};

const mapStorage: PersistStorage<PersistedState> = {
  getItem: (name): StorageValue<PersistedState> | null => {
    const raw = localStorage.getItem(name);
    if (!raw) {
      return null;
    }
    return parsePersistedStorage(raw);
  },
  setItem: (name, value) => {
    localStorage.setItem(name, JSON.stringify(value, replacer));
  },
  removeItem: (name) => {
    localStorage.removeItem(name);
  },
};

type TableStore = {
  columnSizing: Map<string, ColumnSizingState>;
  contentMode: Record<string, TableContentMode>;
  setContentMode: (viewId: string, mode: TableContentMode) => void;
  setColumnSizing: (
    viewId: string,
    updater: Updater<ColumnSizingState>,
  ) => void;
  rowSelection: Record<string, RowSelectionState>;
  setRowSelection: (
    viewId: string,
    updater: Updater<RowSelectionState>,
  ) => void;
  /**
   * Selected entities resolved from `rowSelection`, synced by the
   * table layout so chrome outside the table (view toolbar) can
   * offer bulk actions without rebuilding the entities query.
   */
  selectedEntities: Record<string, WorkspaceEntity[]>;
  setSelectedEntities: (viewId: string, entities: WorkspaceEntity[]) => void;
  pruneStaleViews: (activeViewIds: string[]) => void;
};

export const useTableStore = create<TableStore>()(
  persist(
    immer((set) => ({
      columnSizing: new Map<string, ColumnSizingState>(),
      contentMode: {},
      rowSelection: {},
      selectedEntities: {},

      setContentMode: (viewId, mode) => {
        set((state) => {
          state.contentMode[viewId] = mode;
        });
      },

      setColumnSizing: (viewId, updater) => {
        set((state) => {
          const prev = state.columnSizing.get(viewId) ?? {};
          const next = typeof updater === "function" ? updater(prev) : updater;
          state.columnSizing.set(viewId, next);
        });
      },

      setRowSelection: (viewId, updater) => {
        set((state) => {
          const prev = state.rowSelection[viewId] ?? {};
          const next = typeof updater === "function" ? updater(prev) : updater;
          state.rowSelection[viewId] = next;
        });
      },

      setSelectedEntities: (viewId, entities) => {
        set((state) => {
          const prev = state.selectedEntities[viewId];
          if (selectedEntitiesEqual(prev, entities)) {
            return;
          }
          state.selectedEntities[viewId] = entities;
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
          const prunedContentMode: Record<string, TableContentMode> = {};
          for (const [vid, mode] of Object.entries(state.contentMode)) {
            if (active.has(vid)) {
              prunedContentMode[vid] = mode;
            }
          }
          state.contentMode = prunedContentMode;
          const pruned: Record<string, RowSelectionState> = {};
          for (const [vid, sel] of Object.entries(state.rowSelection)) {
            if (active.has(vid)) {
              pruned[vid] = sel;
            }
          }
          state.rowSelection = pruned;
          const prunedSelectedEntities: Record<string, WorkspaceEntity[]> = {};
          for (const [vid, entities] of Object.entries(
            state.selectedEntities,
          )) {
            if (active.has(vid)) {
              prunedSelectedEntities[vid] = entities;
            }
          }
          state.selectedEntities = prunedSelectedEntities;
        });
      },
    })),
    {
      name: "stella:table",
      storage: mapStorage,
      partialize: (state) => ({
        columnSizing: state.columnSizing,
        contentMode: state.contentMode,
      }),
    },
  ),
);
