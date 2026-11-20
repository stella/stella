import { ENTITY_VIEW_GROUP } from "@stll/api-contract/entity-views";
import {
  getKanbanGroups,
  isKanbanGroupingRenderable,
  resolveKanbanGroupOptions,
} from "@stll/ui/kanban-grouping";
import type { KanbanGroup } from "@stll/ui/kanban-grouping";

import {
  resolveWorkspaceKanbanGrouping,
  workspaceKanbanSchema,
} from "@/components/workspaces/kanban/kanban-grouping.logic";

// The group names a loading view draws are bars, so the built-in groups'
// labels are never read; the schema only needs every key present.
const NO_STATUS_LABELS = {
  open: "",
  in_progress: "",
  in_review: "",
  done: "",
  cancelled: "",
};
const NO_KIND_LABELS = {
  document: "",
  folder: "",
  task: "",
  message: "",
  link: "",
};

/** The grouping a board takes when its view names none. */
export const DEFAULT_ENTITY_VIEW_BOARD_GROUP = ENTITY_VIEW_GROUP.STATUS;

/**
 * The groups a status or kind grouping lays out, in their order with the
 * uncategorized one last, as the board's columns and the grouped table's
 * sections take them. `null` for a grouping whose groups come from the rows
 * (matter, assignee, author, type), which only the loaded rows can say.
 */
export const pendingEntityViewGroups = (
  groupBy: string,
): readonly KanbanGroup[] | null => {
  if (
    groupBy !== ENTITY_VIEW_GROUP.STATUS &&
    groupBy !== ENTITY_VIEW_GROUP.KIND
  ) {
    return null;
  }
  const grouping = resolveWorkspaceKanbanGrouping(
    groupBy,
    workspaceKanbanSchema({
      properties: [],
      statusLabels: NO_STATUS_LABELS,
      entityKindLabels: NO_KIND_LABELS,
    }),
  );
  return isKanbanGroupingRenderable(grouping)
    ? getKanbanGroups(resolveKanbanGroupOptions(grouping), "")
    : null;
};

/**
 * The groups a grouped table lays out while its rows load: the fixed ones of
 * a status or kind grouping, else only the uncategorized group, which is all
 * a grouping drawn from rows has before there are rows.
 */
export const pendingEntityTableGroups = (
  groupBy: string,
): readonly KanbanGroup[] =>
  pendingEntityViewGroups(groupBy) ?? getKanbanGroups([], "");
