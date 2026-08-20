import { useTranslations } from "use-intl";

import type { WorkspaceCalculationLabels } from "@stll/workspace-ui/calculations";

export const useWorkspaceCalculationLabels = () => {
  const t = useTranslations();

  return {
    choose: t("workspaces.calculations.choose"),
    kinds: {
      average: t("workspaces.calculations.kinds.average"),
      count: t("workspaces.calculations.kinds.count"),
      "count-empty": t("workspaces.calculations.kinds.countEmpty"),
      "count-filled": t("workspaces.calculations.kinds.countFilled"),
      "count-unique": t("workspaces.calculations.kinds.countUnique"),
      max: t("workspaces.calculations.kinds.max"),
      median: t("workspaces.calculations.kinds.median"),
      min: t("workspaces.calculations.kinds.min"),
      "percent-empty": t("workspaces.calculations.kinds.percentEmpty"),
      "percent-filled": t("workspaces.calculations.kinds.percentFilled"),
      "percent-of-total": t("workspaces.calculations.kinds.percentOfTotal"),
      range: t("workspaces.calculations.kinds.range"),
      sum: t("workspaces.calculations.kinds.sum"),
    },
    noProperties: t("workspaces.calculations.noProperties"),
    none: t("common.none"),
    unavailable: t("workspaces.calculations.unavailable"),
  } satisfies WorkspaceCalculationLabels;
};
