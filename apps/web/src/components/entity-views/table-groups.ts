import { useMemo } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  getKanbanGroups,
  resolveKanbanGrouping,
  resolveKanbanGroupOptions,
} from "@stll/ui/kanban";

import { ENTITY_VIEW_GROUP, entryGroupValue } from "./model";
import type { EntityViewRow } from "./types";
import { useEntityViewGroupingSchema } from "./use-grouping-schema";

/** Group the loaded window; counts grow as subsequent source pages arrive. */
export const useEntityTableGroups = (
  rows: readonly EntityViewRow[],
  groupBy: string | undefined,
) => {
  const t = useTranslations();
  const schema = useEntityViewGroupingSchema(rows);
  return useMemo(() => {
  const grouping = resolveKanbanGrouping({ groupBy: groupBy ?? "", schema });
  if (grouping.type === "none") {
    return null;
  }
  const groups = getKanbanGroups(
    resolveKanbanGroupOptions(grouping),
    t("inbox.unassigned"),
  ).map((group) => {
    const groupRows: EntityViewRow[] = [];
    return {
      key: JSON.stringify([groupBy, group.value]),
      group,
      rows: groupRows,
    };
  });
  const groupsByValue = new Map(groups.map((group) => [group.group.value, group]));
  for (const row of rows) {
    const values: (string | null)[] = [];
    if (groupBy === ENTITY_VIEW_GROUP.ASSIGNEE) {
      if (row.entry.type === "entity") {
        values.push(...row.entry.entity.assignees.map(({ userId }) => userId));
      } else if (row.entry.signal.assigneeUserId !== null) {
        values.push(row.entry.signal.assigneeUserId);
      }
      if (values.length === 0) {
        values.push(null);
      }
    } else {
      values.push(entryGroupValue(row.entry, grouping.propertyId));
    }
    for (const value of new Set(values)) {
      const group = groupsByValue.get(value);
      if (!group) {
        panic(`Collection group missing for ${String(value)}`);
      }
      group.rows.push(row);
    }
  }
  return groups.filter(({ rows: groupRows }) => groupRows.length > 0);
  }, [groupBy, rows, schema, t]);
};
