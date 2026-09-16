import { useMemo } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { KanbanGroupOption } from "@stll/ui/kanban";

import type { WorkspaceProperty } from "@/lib/types";
import { useWorkspaceKanbanSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/use-kanban-schema";

import { ENTITY_VIEW_GROUP, entryMatterId, entryType } from "./model";
import type { EntityViewRow } from "./types";

const NO_PROPERTIES: readonly WorkspaceProperty[] = [];

export const useEntityViewGroupingSchema = (rows: readonly EntityViewRow[]) => {
  const t = useTranslations();
  const baseSchema = useWorkspaceKanbanSchema(NO_PROPERTIES);
  return useMemo(() => {
    const matters = new Map<string, KanbanGroupOption>();
    const assignees = new Map<string, KanbanGroupOption>();
    const authors = new Map<string, KanbanGroupOption>();
    for (const { entry } of rows) {
      const matterId = entryMatterId(entry);
      if (matterId) {
        matters.set(matterId, {
          value: matterId,
          label:
            entry.type === "entity"
              ? entry.workspaceName
              : (entry.signal.workspaceName ?? t("common.matter")),
        });
      }
      if (entry.type === "entity") {
        for (const assignee of entry.entity.assignees) {
          assignees.set(assignee.userId, {
            value: assignee.userId,
            label: assignee.name ?? t("common.assignee"),
            image: assignee.image,
          });
        }
        if (entry.entity.createdByUserId) {
          authors.set(entry.entity.createdByUserId, {
            value: entry.entity.createdByUserId,
            label: entry.entity.createdBy ?? t("common.author"),
            image: entry.entity.createdByImage,
          });
        }
      } else {
        if (entry.signal.assigneeUserId) {
          assignees.set(entry.signal.assigneeUserId, {
            value: entry.signal.assigneeUserId,
            label: entry.signal.assigneeUserName ?? t("common.assignee"),
            image: entry.signal.assigneeUserImage,
          });
        }
        if (
          entry.signal.createdByUserId &&
          !authors.has(entry.signal.createdByUserId)
        ) {
          authors.set(entry.signal.createdByUserId, {
            value: entry.signal.createdByUserId,
            label: t("common.author"),
          });
        }
      }
    }
    const visibleTypes = rows.map(({ entry }) => entryType(entry));
    visibleTypes.push("task");
    const kindOptions =
      baseSchema.builtInGroups.find(
        (group) => group.id === ENTITY_VIEW_GROUP.KIND,
      )?.options ?? panic("Missing shared kind grouping");
    return {
      ...baseSchema,
      builtInGroups: [
        ...baseSchema.builtInGroups
          .filter(
            (group) =>
              group.id !== ENTITY_VIEW_GROUP.ASSIGNEE &&
              group.id !== ENTITY_VIEW_GROUP.AUTHOR,
          )
          .map((group) => ({
            id: group.id,
            options: group.options,
          })),
        { id: ENTITY_VIEW_GROUP.MATTER, options: [...matters.values()] },
        { id: ENTITY_VIEW_GROUP.ASSIGNEE, options: [...assignees.values()] },
        { id: ENTITY_VIEW_GROUP.AUTHOR, options: [...authors.values()] },
        {
          id: ENTITY_VIEW_GROUP.TYPE,
          options: [
            ...kindOptions.filter((option) =>
              visibleTypes.some((type) => type === option.value),
            ),
            { value: "deadline", label: t("tasks.deadlines") },
          ],
        },
      ],
    };
  }, [baseSchema, rows, t]);
};
