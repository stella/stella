import type {
  ColumnSizingState,
  RowSelectionState,
  Updater,
} from "@tanstack/react-table";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PersistStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { writeStoredJson } from "@/lib/stored-json";
import type { WorkspaceEntity } from "@/lib/types";
import {
  getViewRecord,
  readPersistedTableState,
  reconcileMatterViews,
  setViewRecord,
  TABLE_STORE_VERSION,
  withoutViewRecord,
} from "@/lib/workspaces/table-store.logic";
import type {
  PersistedTableState,
  TableContentMode,
  TableViewRecord,
  TableViewRef,
} from "@/lib/workspaces/table-store.logic";

export type {
  TableContentMode,
  TableViewRef,
} from "@/lib/workspaces/table-store.logic";

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

const validatingStorage: PersistStorage<PersistedTableState> = {
  getItem: (name) => readPersistedTableState(localStorage.getItem(name)),
  setItem: (name, value) => {
    writeStoredJson(localStorage, name, value);
  },
  removeItem: (name) => {
    localStorage.removeItem(name);
  },
};

/**
 * Every per-view record, keyed by matter then view. The reconcile lists them
 * by name: a record added here without a line there is a compile error, not
 * a leak.
 */
type TableViewRecords = PersistedTableState & {
  rowSelection: TableViewRecord<RowSelectionState>;
  /**
   * Selected entities resolved from `rowSelection`, synced by the
   * table layout so chrome outside the table (view toolbar) can
   * offer bulk actions without rebuilding the entities query.
   */
  selectedEntities: TableViewRecord<WorkspaceEntity[]>;
  /**
   * Union of every group section's loaded row ids for a grouped table view,
   * synced by the grouped layout so a section's "select all" can preserve
   * selections in other sections (they share one row selection) without
   * resurrecting ids that dropped out of every section. Read imperatively
   * (`useTableStore.getState()`) from the click handler rather than
   * subscribed, so publishing a growing union never re-renders the table.
   */
  preservableRowIds: TableViewRecord<string[]>;
  /**
   * The find per view. Never persisted: a find is a question about the rows in
   * front of you, not a saved view setting, so it does not survive a reload
   * the way column widths do.
   */
  find: TableViewRecord<TableFind>;
};

type TableStore = TableViewRecords & {
  setContentMode: (ref: TableViewRef, mode: TableContentMode) => void;
  setColumnSizing: (
    ref: TableViewRef,
    updater: Updater<ColumnSizingState>,
  ) => void;
  setRowSelection: (
    ref: TableViewRef,
    updater: Updater<RowSelectionState>,
  ) => void;
  setSelectedEntities: (ref: TableViewRef, entities: WorkspaceEntity[]) => void;
  setPreservableRowIds: (ref: TableViewRef, rowIds: string[]) => void;
  openFind: (ref: TableViewRef) => void;
  /** Hide the bar and keep the term: the rows stay narrowed. */
  closeFind: (ref: TableViewRef) => void;
  /** End the find. The only way back to every row. */
  clearFind: (ref: TableViewRef) => void;
  setFindTyped: (ref: TableViewRef, typed: string) => void;
  /** Submit what is typed: the readers requery it, and the marks follow. */
  submitFind: (ref: TableViewRef) => void;
  setFindScope: (ref: TableViewRef, scope: TableFindSelection) => void;
  /**
   * Drop every record of a view the matter no longer lists. Called from the
   * views query, so any fetch of a matter's views (loader, switcher, a
   * refetch after a delete here or elsewhere) is the one place cleanup
   * happens. Only `liveViewIds`' matter is touched.
   */
  reconcileViews: (workspaceId: string, liveViewIds: readonly string[]) => void;
};

export const useTableStore = create<TableStore>()(
  persist(
    immer((set) => ({
      columnSizing: {},
      contentMode: {},
      rowSelection: {},
      selectedEntities: {},
      preservableRowIds: {},
      find: {},

      setContentMode: (ref, mode) => {
        set((state) => {
          setViewRecord(state.contentMode, ref, mode);
        });
      },

      setColumnSizing: (ref, updater) => {
        set((state) => {
          const prev = getViewRecord(state.columnSizing, ref) ?? {};
          const next = typeof updater === "function" ? updater(prev) : updater;
          setViewRecord(state.columnSizing, ref, next);
        });
      },

      setRowSelection: (ref, updater) => {
        set((state) => {
          const prev = getViewRecord(state.rowSelection, ref) ?? {};
          const next = typeof updater === "function" ? updater(prev) : updater;
          setViewRecord(state.rowSelection, ref, next);
        });
      },

      setSelectedEntities: (ref, entities) => {
        set((state) => {
          const prev = getViewRecord(state.selectedEntities, ref);
          if (selectedEntitiesEqual(prev, entities)) {
            return;
          }
          setViewRecord(state.selectedEntities, ref, entities);
        });
      },

      setPreservableRowIds: (ref, rowIds) => {
        set((state) => {
          setViewRecord(state.preservableRowIds, ref, rowIds);
        });
      },

      openFind: (ref) => {
        set((state) => {
          const current = getViewRecord(state.find, ref);
          if (current) {
            // Reopening keeps what was typed and submitted: the shortcut and
            // the chip both show the running find, they do not start over.
            current.status = "open";
            return;
          }
          setViewRecord(state.find, ref, {
            scope: { type: "all" },
            status: "open",
            submitted: "",
            typed: "",
          });
        });
      },

      closeFind: (ref) => {
        set((state) => {
          const current = getViewRecord(state.find, ref);
          if (current) {
            current.status = "closed";
          }
        });
      },

      clearFind: (ref) => {
        set((state) => {
          state.find = withoutViewRecord(state.find, ref);
        });
      },

      setFindTyped: (ref, typed) => {
        set((state) => {
          const current = getViewRecord(state.find, ref);
          if (current) {
            current.typed = typed;
          }
        });
      },

      submitFind: (ref) => {
        set((state) => {
          const current = getViewRecord(state.find, ref);
          if (current) {
            current.submitted = current.typed;
          }
        });
      },

      setFindScope: (ref, scope) => {
        set((state) => {
          const current = getViewRecord(state.find, ref);
          if (current) {
            current.scope = scope;
          }
        });
      },

      reconcileViews: (workspaceId, liveViewIds) => {
        set((state) => {
          const live = new Set(liveViewIds);
          const next: TableViewRecords = {
            columnSizing: reconcileMatterViews(
              state.columnSizing,
              workspaceId,
              live,
            ),
            contentMode: reconcileMatterViews(
              state.contentMode,
              workspaceId,
              live,
            ),
            rowSelection: reconcileMatterViews(
              state.rowSelection,
              workspaceId,
              live,
            ),
            selectedEntities: reconcileMatterViews(
              state.selectedEntities,
              workspaceId,
              live,
            ),
            preservableRowIds: reconcileMatterViews(
              state.preservableRowIds,
              workspaceId,
              live,
            ),
            find: reconcileMatterViews(state.find, workspaceId, live),
          };
          Object.assign(state, next);
        });
      },
    })),
    {
      name: "stella:table",
      version: TABLE_STORE_VERSION,
      storage: validatingStorage,
      partialize: (state) => ({
        columnSizing: state.columnSizing,
        contentMode: state.contentMode,
      }),
    },
  ),
);
