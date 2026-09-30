import {
  TIME_ENTRY_ACTIVITY_GROUP,
  type TimeEntryActivityGroup,
} from "@stll/api-contract";

import type { ManualTimeEntryValues } from "./manual-time-entry-form";

type ManualTimeEntryInput = {
  activityGroup: TimeEntryActivityGroup;
  dateWorked: string;
  durationMinutes: number;
  narrative: string;
  narrativeLanguage: string | null;
  billable: boolean;
};

export const manualTimeEntryValues = (
  input: ManualTimeEntryInput,
): ManualTimeEntryValues => {
  const fields = {
    dateWorked: input.dateWorked,
    durationMinutes: input.durationMinutes,
    narrative: input.narrative.trim(),
    narrativeLanguage: input.narrativeLanguage,
  };
  return input.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT
    ? {
        ...fields,
        activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
        billable: input.billable,
      }
    : { ...fields, activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL };
};
