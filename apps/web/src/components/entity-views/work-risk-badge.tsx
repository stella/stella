import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { ENTITY_VIEW_WORK_RISK } from "@stll/api-contract/entity-views";
import type { EntityViewWorkRisk } from "@stll/api-contract/entity-views";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";

/** Marks a task whose governed work is open and already due. */
export const WorkRiskBadge = ({ risk }: { risk: EntityViewWorkRisk }) => {
  const t = useTranslations();
  switch (risk) {
    case ENTITY_VIEW_WORK_RISK.AT_RISK:
      return (
        <ReviewStatusBadge tone="warning">
          {t("tasks.queue.atRisk")}
        </ReviewStatusBadge>
      );
    case ENTITY_VIEW_WORK_RISK.NONE:
      return null;
    default:
      risk satisfies never;
      return panic("Unknown work risk");
  }
};
