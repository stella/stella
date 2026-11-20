import { usePendingTextLabel } from "@/components/pending-text";
import type { MattersColumnId } from "@/lib/workspaces/types";
import { MATTERS_COLUMN_LABEL_KEYS } from "@/routes/_protected.workspaces/-hooks/matters-labels.logic";

export const useColumnLabels = (): Record<MattersColumnId, string> => {
  const pendingLabel = usePendingTextLabel();
  const label = (id: MattersColumnId) =>
    pendingLabel(MATTERS_COLUMN_LABEL_KEYS[id]);
  return {
    client: label("client"),
    team: label("team"),
    reference: label("reference"),
    entityCount: label("entityCount"),
    lastActivityAt: label("lastActivityAt"),
    createdAt: label("createdAt"),
  };
};
