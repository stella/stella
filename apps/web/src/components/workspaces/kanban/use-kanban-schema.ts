import { useTranslations } from "use-intl";

import { ENTITY_KIND_GROUP_LABEL_IDS } from "@/components/workspaces/kanban/kanban-group-labels.logic";
import type { WorkspaceKanbanSchema } from "@/components/workspaces/kanban/kanban-view.logic";
import { workspaceKanbanSchema } from "@/components/workspaces/kanban/kanban-view.logic";
import type { WorkspaceProperty } from "@/lib/types";

/**
 * The workspace's kanban schema, with the column labels every built-in grouping
 * needs. Both the board and the grouped table read their columns through it, so
 * the two agree on what a group is called.
 */
export const useWorkspaceKanbanSchema = (
  properties: readonly WorkspaceProperty[],
): WorkspaceKanbanSchema => {
  const t = useTranslations();

  return workspaceKanbanSchema({
    properties,
    statusLabels: {
      open: t("tasks.statusValues.open"),
      in_progress: t("tasks.statusValues.in_progress"),
      in_review: t("tasks.statusValues.in_review"),
      done: t("tasks.statusValues.done"),
      cancelled: t("tasks.statusValues.cancelled"),
    },
    entityKindLabels: {
      document: t(ENTITY_KIND_GROUP_LABEL_IDS.document),
      folder: t(ENTITY_KIND_GROUP_LABEL_IDS.folder),
      task: t(ENTITY_KIND_GROUP_LABEL_IDS.task),
      message: t(ENTITY_KIND_GROUP_LABEL_IDS.message),
      link: t(ENTITY_KIND_GROUP_LABEL_IDS.link),
    },
  });
};
