import { useTranslations } from "use-intl";

import { durationParts } from "./activity-logic";

/** Writes a duration as the activity window shows it: hours and minutes,
 * minutes, or under a minute. */
export const useDurationLabel = () => {
  const t = useTranslations("activity");
  return (durationMs: number) => {
    const { hours, minutes } = durationParts(durationMs);
    if (hours > 0) {
      return t("durationHoursMinutes", { hours, minutes });
    }
    if (minutes > 0) {
      return t("durationMinutes", { minutes });
    }
    return t("durationUnderMinute");
  };
};
