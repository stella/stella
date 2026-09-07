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

import { readStoredJson } from "@/lib/stored-json";
import type { WorkspaceEntity } from "@/lib/types";

const MAP_TAG = "__map";
const TABLE_CONTENT_MODES = ["tight", "fit-content"] as const;

export type TableContentMode = (typeof TABLE_CONTENT_MODES)[number];

/**
 * How wide a find reaches. `all` is the state the bar opens in: no
 * column chosen, so the row's name counts too. Narrowing to columns is a
 * different question, not a shorter list, which is why it is a branch rather
 * than an empty array.
 */
export type TableFindSelection =
  | { type: "all" }
  | { propertyIds: string[]; type: "columns" };

/**
 * A view's find. Absent from the record means there is no find at all; the
 * bar's own visibility is `status` alone, because a find outlives its editor.
 * Closing the popover leaves the rows narrowed and the toolbar chip explaining
 * why, and `clearFind` is the only thing that ends it.
 *
 * `typed` is what the input holds this keystroke. `submitted` is what the row
 * readers have actually been asked for, and so what the rows on screen and
 * their marks reflect. They are separate because the bar debounces: keeping
 * one field would either lag the input by a quarter second or refetch on every
 * keystroke, and "search now" (Enter) needs something to submit early into.
 *
 * Only `submitted` may reach a query key or a highlight. Highlighting against
 * `typed` would mark runs the server has not answered for, so the marks would
 * run ahead of the rows they are meant to explain.
 */
export type TableFind = {
  scope: TableFindSelection;
  status: "closed" | "open";
  submitted: string;
  typed: string;
};

const pruneByViewId = <T>(
  record: Record<string, T>,
  activeViewIds: ReadonlySet<string>,
): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).filter(([viewId]) => activeViewIds.has(viewId)),
  );

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
const parsePersistedStorage = (
  json: string,
): StorageValue<PersistedState> | null => {
  const result = readStoredJson(json, StorageSchema);
  if (!result) {
    return null;
  }
  const entries = result.state.columnSizing[MAP_TAG];
  const columnSizing = new Map<string, ColumnSizingState>(entries);
  return {
    state: {
      columnSizing,
      contentMode:
        result.state.contentMode ?? result.state.columnWidthMode ?? {},
    },
    version: result.version,
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
  /**
   * Union of every group section's loaded row ids for a grouped table view,
   * synced by the grouped layout so a section's "select all" can preserve
   * selections in other sections (they share one row selection) without
   * resurrecting ids that dropped out of every section. Read imperatively
   * (`useTableStore.getState()`) from the click handler rather than
   * subscribed, so publishing a growing union never re-renders the table.
   */
  preservableRowIds: Record<string, string[]>;
  setPreservableRowIds: (viewId: string, rowIds: string[]) => void;
  /**
   * The find per view. Never persisted: a find is a question about the rows in
   * front of you, not a saved view setting, so it does not survive a reload
   * the way column widths do.
   */
  find: Record<string, TableFind>;
  openFind: (viewId: string) => void;
  /** Hide the bar and keep the term: the rows stay narrowed. */
  closeFind: (viewId: string) => void;
  /** End the find. The only way back to every row. */
  clearFind: (viewId: string) => void;
  setFindTyped: (viewId: string, typed: string) => void;
  /** Submit what is typed: the readers requery it, and the marks follow. */
  submitFind: (viewId: string) => void;
  setFindScope: (viewId: string, scope: TableFindSelection) => void;
  pruneStaleViews: (activeViewIds: string[]) => void;
};

export const useTableStore = create<TableStore>()(
  persist(
    immer((set) => ({
      columnSizing: new Map<string, ColumnSizingState>(),
      contentMode: {},
      rowSelection: {},
      selectedEntities: {},
      preservableRowIds: {},
      find: {},

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

      setPreservableRowIds: (viewId, rowIds) => {
        set((state) => {
          state.preservableRowIds[viewId] = rowIds;
        });
      },

      openFind: (viewId) => {
        set((state) => {
          const current = state.find[viewId];
          if (current) {
            // Reopening keeps what was typed and submitted: the shortcut and
            // the chip both show the running find, they do not start over.
            current.status = "open";
            return;
          }
          state.find[viewId] = {
            scope: { type: "all" },
            status: "open",
            submitted: "",
            typed: "",
          };
        });
      },

      closeFind: (viewId) => {
        set((state) => {
          const current = state.find[viewId];
          if (current) {
            current.status = "closed";
          }
        });
      },

      clearFind: (viewId) => {
        set((state) => {
          state.find = Object.fromEntries(
            Object.entries(state.find).filter(([id]) => id !== viewId),
          );
        });
      },

      setFindTyped: (viewId, typed) => {
        set((state) => {
          const current = state.find[viewId];
          if (current) {
            current.typed = typed;
          }
        });
      },

      submitFind: (viewId) => {
        set((state) => {
          const current = state.find[viewId];
          if (current) {
            current.submitted = current.typed;
          }
        });
      },

      setFindScope: (viewId, scope) => {
        set((state) => {
          const current = state.find[viewId];
          if (current) {
            current.scope = scope;
          }
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
          state.contentMode = pruneByViewId(state.contentMode, active);
          state.rowSelection = pruneByViewId(state.rowSelection, active);
          state.selectedEntities = pruneByViewId(
            state.selectedEntities,
            active,
          );
          state.preservableRowIds = pruneByViewId(
            state.preservableRowIds,
            active,
          );
          state.find = pruneByViewId(state.find, active);
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
