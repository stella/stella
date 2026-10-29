import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  DECISION_TEXT_AVAILABILITY,
  type DecisionTextAvailability,
} from "@stll/api-contract/case-law-text-field";

export const DecisionTextAvailabilityMarker = ({
  availability,
}: {
  availability: DecisionTextAvailability;
}) => {
  const t = useTranslations();
  switch (availability) {
    case DECISION_TEXT_AVAILABILITY.AVAILABLE:
      return null;
    case DECISION_TEXT_AVAILABILITY.METADATA_ONLY:
      return (
        <span className="text-muted-foreground text-xs">
          {t("caseLaw.research.answers.failureReasons.noText")}
        </span>
      );
    default:
      availability satisfies never;
      return panic(
        `Unhandled decision text availability: ${String(availability)}`,
      );
  }
};
