import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import type { ManualTimeEntryValues } from "@/components/billing/manual-time-entry-form";
import { APIError } from "@/lib/errors/api";

export const emptyQuickEntryValues = (
  dateWorked: string,
): ManualTimeEntryValues => ({
  activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
  dateWorked,
  durationMinutes: 0,
  narrative: "",
  narrativeLanguage: null,
  billable: true,
});

export const quickEntryRefusalKey = (error: unknown) => {
  if (!APIError.is(error)) {
    return "errors.actionFailed";
  }
  switch (error.code) {
    case "invalid_date_worked":
      return "billing.quickEntry.invalidDate";
    case "future_date_worked":
      return "billing.quickEntry.futureDate";
    case "outside_edit_window":
      return "billing.quickEntry.outsideEditWindow";
    case "narrative_required":
      return "billing.quickEntry.narrativeRequired";
    case "time_period_locked":
      return "billing.quickEntry.periodLocked";
    case undefined:
      return "errors.actionFailed";
    default:
      return "errors.actionFailed";
  }
};
