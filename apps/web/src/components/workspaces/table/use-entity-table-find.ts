import { useMemo } from "react";

import { resolveEntityFind } from "@/components/workspaces/table/entity-find.logic";
import type { EntityFindResolution } from "@/components/workspaces/table/entity-find.logic";
import { UNRESTRICTED_FIND } from "@/components/workspaces/table/table-find.logic";
import type { TableFindPersistence } from "@/components/workspaces/table/table-find.logic";
import type { WorkspaceProperty } from "@/lib/types";
import { useTableStore } from "@/lib/workspaces/table-store";
import type { TableViewRef } from "@/lib/workspaces/table-store";

/**
 * One resolution of a view's find, read by the toolbar that edits it and by
 * the readers that send it. It reads `submitted`, never `typed`, so a row
 * query and the marks drawn over its answer always describe the same term.
 *
 * Subscribed to `submitted` and `scope` separately rather than to the find as
 * a whole: a keystroke changes only `typed`, and the layouts under this hook
 * re-render every mounted cell when it returns a new object. The result is
 * memoized for the same reason, and so the layouts can defer it.
 */
export const useEntityTableFind = ({
  hasNameColumn,
  hiddenProperties,
  properties,
  view,
}: {
  /** Whether the grid renders a name column; the unrestricted scope matches it. */
  hasNameColumn: boolean;
  hiddenProperties: readonly string[];
  properties: WorkspaceProperty[];
  view: TableViewRef;
}): EntityFindResolution => {
  const { viewId, workspaceId } = view;
  const term = useTableStore(
    (state) => state.find[workspaceId]?.[viewId]?.submitted ?? "",
  );
  const selection = useTableStore(
    (state) => state.find[workspaceId]?.[viewId]?.scope ?? UNRESTRICTED_FIND,
  );

  return useMemo(
    () =>
      resolveEntityFind({
        hasNameColumn,
        hiddenProperties,
        properties,
        selection,
        term,
      }),
    [hasNameColumn, hiddenProperties, properties, selection, term],
  );
};

/**
 * A view's find as the shared bar writes it: the table store, keyed by view.
 * Not persisted, because a find is a question about the rows in front of you
 * rather than a saved view setting.
 */
export const useEntityFindPersistence = (
  view: TableViewRef,
): TableFindPersistence => {
  const state = useTableStore(
    (store) => store.find[view.workspaceId]?.[view.viewId],
  );
  const openFind = useTableStore((store) => store.openFind);
  const closeFind = useTableStore((store) => store.closeFind);
  const clearFind = useTableStore((store) => store.clearFind);
  const setFindTyped = useTableStore((store) => store.setFindTyped);
  const submitFind = useTableStore((store) => store.submitFind);
  const setFindScope = useTableStore((store) => store.setFindScope);

  return {
    clear: () => {
      clearFind(view);
    },
    close: () => {
      closeFind(view);
    },
    key: view.viewId,
    open: () => {
      openFind(view);
    },
    setScope: (scope) => {
      setFindScope(view, scope);
    },
    setTyped: (typed) => {
      setFindTyped(view, typed);
    },
    state,
    submit: () => {
      submitFind(view);
    },
  };
};
