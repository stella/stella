import { Temporal } from "@stll/time";

import type { ActivityBlock } from "./activity-logic";

export type ConfirmedTimeEntry = {
  workspaceId: string;
  dateWorked: string;
  timezoneId: string;
  durationMinutes: number;
  narrative: string;
  billable: boolean;
};

export type LocalEntryBlock = { date: string; start: string; end: string };

/** Select only editable billing fields; activity metadata never enters the entry. */
export const initialTimeEntry = (date: string, block: ActivityBlock) =>
  ({
    billable: true,
    dateWorked: date,
    durationMinutes: block.roundedTenths * 6,
    narrative: "",
    timezoneId: Temporal.Now.timeZoneId(),
    workspaceId: "",
  }) satisfies ConfirmedTimeEntry;

export const localEntryBlock = (
  date: string,
  block: ActivityBlock,
): LocalEntryBlock => ({
  date,
  end: Temporal.Instant.fromEpochMilliseconds(block.endMs).toString(),
  start: Temporal.Instant.fromEpochMilliseconds(block.startMs).toString(),
});
