import { useTranslations } from "use-intl";

import type { MattersSortKey } from "@/routes/_protected.workspaces/-types";

export const useSortLabels = (): Record<MattersSortKey, string> => {
  const t = useTranslations();
  return {
    name: t("billing.matter"),
    reference: t("common.reference"),
    entityCount: t("workspaces.overview.totalItems"),
    lastActivityAt: t("workspaces.lastActive", { time: "" }).trim(),
    createdAt: t("common.createdAt", { date: "" }).trim(),
    clientName: t("workspaces.parties.client"),
  };
};
