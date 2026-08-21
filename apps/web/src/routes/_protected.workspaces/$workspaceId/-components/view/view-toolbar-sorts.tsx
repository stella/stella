import { useTranslations } from "use-intl";

import { VIEW_SORTS_MAX } from "@stll/api-contract";
import { SortChips as WorkspaceSortChips } from "@stll/workspace-ui/sorts";

import type { ViewLayout, WorkspaceProperty } from "@/lib/types";

type SortChipsProps = {
  sorts: ViewLayout["sorts"];
  properties: WorkspaceProperty[];
  onUpdate: (sorts: ViewLayout["sorts"]) => void;
};

/** The view's sort chips, with this app's wording and property list. */
export const SortChips = ({ sorts, properties, onUpdate }: SortChipsProps) => {
  const t = useTranslations();

  return (
    <WorkspaceSortChips
      labels={{ add: t("common.add"), remove: t("common.remove") }}
      maxSorts={VIEW_SORTS_MAX}
      onUpdate={onUpdate}
      properties={properties.map((property) => ({
        id: property.id,
        name: property.name,
        type: property.content.type,
      }))}
      sorts={sorts}
    />
  );
};
