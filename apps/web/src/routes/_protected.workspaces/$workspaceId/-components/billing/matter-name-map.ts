import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

/**
 * Returns a Map<entityId, displayName> for all entities
 * in the workspace. Used by timesheet views to resolve
 * matter names without duplicating the extraction logic.
 */
export const useMatterNameMap = (workspaceId: string) => {
  const t = useTranslations();
  const { data: entities } = useSuspenseQuery(entitiesOptions(workspaceId));

  return useMemo(() => {
    const map = new Map<string, string>();
    if (!entities) {
      return map;
    }
    for (const entity of entities) {
      const nameField = entity.fields.find(
        (f) => f.content.type === "text" || f.content.type === "file",
      );
      const name =
        nameField && "value" in nameField.content
          ? nameField.content.value
          : nameField && "filename" in nameField.content
            ? nameField.content.filename
            : t("workspaces.defaultName");
      map.set(entity.entityId, String(name));
    }
    return map;
  }, [entities, t]);
};
