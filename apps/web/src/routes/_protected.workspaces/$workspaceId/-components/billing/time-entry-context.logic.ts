import type { TimeEntry } from "@stll/api-contract/time-entry-types";

export const UNAVAILABLE_TIME_ENTRY_CONTEXT = "unavailable";

type TimeEntryContext = Pick<TimeEntry, "workItemId" | "workItemReference">;

export const timeEntryContextKey = (entry: TimeEntryContext) =>
  entry.workItemReference?.type === "unavailable"
    ? UNAVAILABLE_TIME_ENTRY_CONTEXT
    : entry.workItemId;

/** An unchanged unavailable selection preserves the ledger's stored reference. */
export const timeEntryContextUpdate = (
  entry: TimeEntryContext,
  selectedId: string,
) =>
  entry.workItemReference?.type === "unavailable" && selectedId === ""
    ? {}
    : { workItemId: selectedId };
