import type { QueryClient } from "@tanstack/react-query";
import type {
  ColumnSizingState,
  RowSelectionState,
  Updater,
} from "@tanstack/react-table";
import { panic, Result } from "better-result";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PersistStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { writeStoredJson } from "@/lib/stored-json";
import type { WorkspaceEntity } from "@/lib/types";
import { viewsQueryWorkspaceId } from "@/lib/workspaces/queries/views.logic";
import {
  pruneMatterViews,
  readPersistedTableState,
  TABLE_STORE_VERSION,
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

const getViewRecord = <T>(
  record: TableViewRecord<T>,
  { workspaceId, viewId }: TableViewRef,
): T | undefined => record[workspaceId]?.[viewId];

const setViewRecord = <T>(
  record: TableViewRecord<T>,
  { workspaceId, viewId }: TableViewRef,
  value: T,
): void => {
  (record[workspaceId] ??= {})[viewId] = value;
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

/**
 * `localStorage` is read per call, never captured: the global is absent on
 * the server, and its getter throws where site data is blocked (a sandboxed
 * frame, "block all cookies"). Persistence is best-effort, so either case
 * runs the store from memory instead of failing the `set` that reached it.
 */
const localStorageOrNull = (): Storage | null =>
  Result.try(() => localStorage).unwrapOr(null);

const validatingStorage: PersistStorage<PersistedTableState> = {
  getItem: (name) => {
    const storage = localStorageOrNull();
    return storage ? readPersistedTableState(storage.getItem(name)) : null;
  },
  setItem: (name, value) => {
    const storage = localStorageOrNull();
    if (storage) {
      writeStoredJson(storage, name, value);
    }
  },
  removeItem: (name) => {
    localStorageOrNull()?.removeItem(name);
  },
};

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
  /** Drop every record of a view `workspaceId` no longer lists. */
  reconcileViews: (workspaceId: string, liveViewIds: readonly string[]) => void;
  /** Drop every record of `workspaceId`: a deleted matter never lists views again. */
  dropMatter: (workspaceId: string) => void;
};

/**
 * Every store field holding per-view state, whichever type declared it.
 * Derived from the store so a record added anywhere in `TableStore` is
 * reconciled or does not compile.
 */
type TableViewRecordKey = {
  [K in keyof TableStore]: TableStore[K] extends TableViewRecord<unknown>
    ? K
    : never;
}[keyof TableStore];

/** Every per-view record, empty. Total: a new record must be listed here. */
export const EMPTY_TABLE_VIEW_RECORDS = {
  columnSizing: {},
  contentMode: {},
  rowSelection: {},
  selectedEntities: {},
  preservableRowIds: {},
  find: {},
} satisfies Record<TableViewRecordKey, TableViewRecord<never>>;

const keysOf = <K extends string>(record: Record<K, unknown>): K[] => {
  const keys: K[] = [];
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      keys.push(key);
    }
  }
  return keys;
};

export const TABLE_VIEW_RECORD_KEYS = keysOf(EMPTY_TABLE_VIEW_RECORDS);

/**
 * Every record with `workspaceId`'s views filtered by `keep`, or `null` when
 * no record changes. Callers skip `set` on `null`: `persist` rewrites storage
 * on every `set`, and a write that only echoes this tab's memory would clobber
 * widths another tab saved since this one hydrated.
 */
const pruneRecords = (
  state: TableViewRecords,
  workspaceId: string,
  keep: (viewId: string) => boolean,
): TableViewRecords | null => {
  const prune = <T>(record: TableViewRecord<T>) =>
    pruneMatterViews(record, workspaceId, keep);
  const next = {
    columnSizing: prune(state.columnSizing),
    contentMode: prune(state.contentMode),
    rowSelection: prune(state.rowSelection),
    selectedEntities: prune(state.selectedEntities),
    preservableRowIds: prune(state.preservableRowIds),
    find: prune(state.find),
  } satisfies Record<TableViewRecordKey, unknown>;
  const changed = TABLE_VIEW_RECORD_KEYS.some(
    (key) => next[key] !== state[key],
  );
  return changed ? next : null;
};

export const useTableStore = create<TableStore>()(
  persist(
    immer((set, get) => ({
      ...EMPTY_TABLE_VIEW_RECORDS,

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
          state.find = pruneMatterViews(
            state.find,
            ref.workspaceId,
            (viewId) => viewId !== ref.viewId,
          );
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
        const live = new Set(liveViewIds);
        const next = pruneRecords(get(), workspaceId, (viewId) =>
          live.has(viewId),
        );
        if (next) {
          set(next);
        }
      },

      dropMatter: (workspaceId) => {
        const next = pruneRecords(get(), workspaceId, () => false);
        if (next) {
          set(next);
        }
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

const reconcileInstalledClients = new WeakSet<QueryClient>();

const hasViewId = (view: unknown): view is { id: string } =>
  typeof view === "object" &&
  view !== null &&
  "id" in view &&
  typeof view.id === "string";

const isViewList = (data: unknown): data is readonly { id: string }[] =>
  Array.isArray(data) && data.every(hasViewId);

/**
 * Reconcile per-view records whenever a matter's views list lands in the
 * query cache: a fetch, a `setQueryData`, or a rollback. Every path that
 * removes a view ends in one of those, so this is the one owner of per-view
 * cleanup. The list is complete (`handlers/views/list.ts`), so absence means
 * deleted. Installed beside the `QueryClient`, like the PDF and chat runtime
 * cleanups, rather than inside the query function: a cache subscriber also
 * sees manual writes, and keeps this persisted store out of the query module
 * every route and chat provider imports.
 */
export const installTableStoreReconcile = (queryClient: QueryClient) => {
  if (reconcileInstalledClients.has(queryClient)) {
    return;
  }
  reconcileInstalledClients.add(queryClient);

  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") {
      return;
    }
    const workspaceId = viewsQueryWorkspaceId(event.query.queryKey);
    if (workspaceId === null) {
      return;
    }
    const views: unknown = event.action.data;
    if (!isViewList(views)) {
      panic("The views query resolved to something other than views");
    }
    useTableStore.getState().reconcileViews(
      workspaceId,
      views.map((view) => view.id),
    );
  });
};
