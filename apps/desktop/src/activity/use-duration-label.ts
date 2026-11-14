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

/** Writes a duration counted in whole minutes, as a suggestion's pieces and
 * its card count it: never in hours, so the minutes can be added up. */
export const useMinutesLabel = () => {
  const t = useTranslations("activity");
  return (minutes: number) =>
    minutes > 0 ? t("durationMinutes", { minutes }) : t("durationUnderMinute");
};
