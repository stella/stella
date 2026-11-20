import { usePendingTextLabel } from "@/components/pending-text";
import type { MattersSortKey } from "@/lib/workspaces/types";
import { MATTERS_SORT_LABEL_KEYS } from "@/routes/_protected.workspaces/-hooks/matters-labels.logic";

export const useSortLabels = (): Record<MattersSortKey, string> => {
  const pendingLabel = usePendingTextLabel();
  const label = (key: MattersSortKey) =>
    pendingLabel(MATTERS_SORT_LABEL_KEYS[key]);
  return {
    name: label("name"),
    reference: label("reference"),
    entityCount: label("entityCount"),
    lastActivityAt: label("lastActivityAt"),
    createdAt: label("createdAt"),
    clientName: label("clientName"),
  };
};
