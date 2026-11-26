import { useFormatter, useTranslations } from "use-intl";

import { roundToBillingIncrement } from "@stll/api-contract/billing";

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

/** The organization's minimum billing unit, once the review has read it. */
export type EntryBilling =
  { type: "unknown" } | { minimumUnitMinutes: number; type: "known" };

/** A tenth of an hour, in minutes. */
const TENTH_MINUTES = 6;

/** Writes what an entry of some worked minutes bills under the
 * organization's minimum unit: in tenths of an hour when every billed figure
 * is a whole tenth, else in minutes. */
export const useBilledLabel = () => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const minutesLabel = useMinutesLabel();
  return (workedMinutes: number, minimumUnitMinutes: number) => {
    const billed = roundToBillingIncrement(workedMinutes, minimumUnitMinutes);
    return minimumUnitMinutes % TENTH_MINUTES === 0
      ? t("hours", {
          hours: format.number(billed / 60, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        })
      : minutesLabel(billed);
  };
};
