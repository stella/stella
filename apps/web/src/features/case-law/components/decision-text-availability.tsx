import { useTranslations } from "use-intl";

import {
  type DecisionTextAvailability,
  decisionTextStatusMarker,
} from "@stll/api-contract/case-law-text-field";
import type { CaseLawTextStatus } from "@stll/api-contract/case-law-text-status";

export const DecisionTextAvailabilityMarker = ({
  availability,
  textState,
}: {
  availability: DecisionTextAvailability;
  textState: CaseLawTextStatus | null;
}) => {
  const t = useTranslations();
  const key = decisionTextStatusMarker(textState, availability);
  if (key === null) {
    return null;
  }
  return (
    <span className="text-muted-foreground text-xs">
      {key === "noDecisionText"
        ? t("caseLaw.research.answers.failureReasons.noText")
        : t(`caseLaw.textState.${key}`)}
    </span>
  );
};
