import { useMemo } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";

import { entitySummariesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

/**
 * Returns a Map<entityId, displayName> for all entities
 * in the workspace. Used by timesheet views to resolve
 * matter names without duplicating the extraction logic.
 */
export const useMatterNameMap = (workspaceId: string) => {
  const { data: summaries } = useSuspenseQuery(
    entitySummariesOptions(workspaceId),
  );

  return useMemo(() => {
    const map = new Map<string, string>();
    for (const summary of summaries) {
      map.set(summary.id, summary.name);
    }
    return map;
  }, [summaries]);
};
