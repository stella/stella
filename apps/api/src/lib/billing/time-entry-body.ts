import * as v from "valibot";

import { API_CALENDAR_DATE_CHECK } from "@stll/api-contract/api-date";

import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import { resourceIdSchema } from "@/api/lib/custom-schema";

/** The work narrative a time entry records. */
export const timeEntryNarrativeSchema = v.pipe(
  v.string(),
  v.minLength(0),
  v.maxLength(10_000),
  v.description("Description of the work"),
);

/** Whether a time entry is billable to the client. */
export const timeEntryBillableSchema = v.pipe(
  v.boolean(),
  v.description("Whether the entry is billable to the client"),
);

/** A UTBMS/LEDES task or activity code, or null for none. */
export const utbmsCodeSchema = (description: string) =>
  v.nullable(v.pipe(v.string(), v.maxLength(20), v.description(description)));

export const createTimeEntryBodySchema = v.strictObject({
  workItemId: v.optional(
    v.nullable(
      resourceIdSchema("entity", {
        description:
          "Optional document, folder, or task that provides context for the work",
      }),
    ),
  ),
  dateWorked: v.pipe(
    v.string(),
    v.isoDate(),
    API_CALENDAR_DATE_CHECK,
    v.description("Date the work was done (ISO YYYY-MM-DD)"),
  ),
  timezoneId: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.description(
      "IANA time zone the dateWorked is interpreted in (e.g. Europe/Prague)",
    ),
  ),
  durationMinutes: v.pipe(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
    v.description("Minutes worked (whole minutes)"),
  ),
  narrative: timeEntryNarrativeSchema,
  narrativeLanguage: v.optional(narrativeLanguageSchema),
  billable: v.optional(timeEntryBillableSchema),
  taskCode: v.optional(
    utbmsCodeSchema("UTBMS/LEDES task code; pass null to clear"),
  ),
  activityCode: v.optional(
    utbmsCodeSchema("UTBMS/LEDES activity code; pass null to clear"),
  ),
});
