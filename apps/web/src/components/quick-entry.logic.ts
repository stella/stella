import { APIError } from "@/lib/errors/api";
import type { ManualTimeEntryValues } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/manual-time-entry-form";

export const emptyQuickEntryValues = (
  dateWorked: string,
): ManualTimeEntryValues => ({
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
    default:
      return "errors.actionFailed";
  }
};
