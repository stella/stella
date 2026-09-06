import { useMemo } from "react";

import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import {
  resolveTableFind,
  UNRESTRICTED_FIND,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import type { TableFindResolution } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";

/**
 * One resolution of a view's find bar, read by the toolbar that edits it and by
 * the readers that send it. It reads `submitted`, never `typed`, so a row query
 * and the marks drawn over its answer always describe the same term.
 *
 * Subscribed to `submitted` and `scope` separately rather than to the find as
 * a whole: a keystroke changes only `typed`, and the layouts under this hook
 * re-render every mounted cell when it returns a new object. The result is
 * memoized for the same reason, and so the layouts can defer it.
 */
export const useTableFind = ({
  properties,
  view,
}: {
  properties: WorkspaceProperty[];
  view: WorkspaceView<"table">;
}): TableFindResolution => {
  const term = useTableStore((state) => state.find[view.id]?.submitted ?? "");
  const selection = useTableStore(
    (state) => state.find[view.id]?.scope ?? UNRESTRICTED_FIND,
  );
  const { layout } = view;

  return useMemo(
    () => resolveTableFind({ layout, properties, selection, term }),
    [layout, properties, selection, term],
  );
};
