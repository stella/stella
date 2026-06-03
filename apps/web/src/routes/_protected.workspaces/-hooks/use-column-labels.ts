import { useTranslations } from "use-intl";

import type { MattersColumnId } from "@/routes/_protected.workspaces/-types";

export const useColumnLabels = (): Record<MattersColumnId, string> => {
  const t = useTranslations();
  return {
    client: t("workspaces.parties.client"),
    team: t("workspaces.team"),
    reference: t("common.reference"),
    entityCount: t("workspaces.overview.totalItems"),
    lastActivityAt: t("workspaces.lastActive", { time: "" }).trim(),
    createdAt: t("common.createdAt", { date: "" }).trim(),
  };
};
