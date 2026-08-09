import * as v from "valibot";

const timeEntryStatusSchema = v.picklist([
  "draft",
  "approved",
  "billed",
  "written_off",
]);

const timeEntrySourceSchema = v.picklist(["manual", "timer"]);

const timeEntrySchema = v.object({
  activityCode: v.nullable(v.string()),
  billable: v.boolean(),
  billedMinutes: v.number(),
  createdAt: v.string(),
  currency: v.string(),
  dateWorked: v.string(),
  durationMinutes: v.number(),
  id: v.string(),
  invoiceNarrative: v.nullable(v.string()),
  narrative: v.string(),
  noCharge: v.boolean(),
  rateAtEntry: v.number(),
  source: timeEntrySourceSchema,
  status: timeEntryStatusSchema,
  taskCode: v.nullable(v.string()),
  timerStartedAt: v.nullable(v.string()),
  timerStoppedAt: v.nullable(v.string()),
  timezoneId: v.string(),
  updatedAt: v.nullable(v.string()),
  userId: v.nullable(v.string()),
  userName: v.nullable(v.string()),
  workItemId: v.nullable(v.string()),
});

const timeEntryListPageSchema = v.object({
  items: v.array(timeEntrySchema),
  limit: v.number(),
  nextCursor: v.nullable(v.string()),
});

const personalTimeEntrySummarySchema = v.object({
  billedMinutes: v.number(),
  entryCount: v.number(),
  scope: v.literal("personal"),
  totalMinutes: v.number(),
});

const teamTimeEntrySummarySchema = v.object({
  members: v.array(
    v.object({
      daily: v.array(
        v.object({
          dateWorked: v.string(),
          totalMinutes: v.number(),
        }),
      ),
      email: v.string(),
      image: v.nullable(v.string()),
      name: v.string(),
      userId: v.string(),
    }),
  ),
  scope: v.literal("team"),
  viewerTotalMinutes: v.number(),
});

const timeEntrySummarySchema = v.variant("scope", [
  personalTimeEntrySummarySchema,
  teamTimeEntrySummarySchema,
]);

const idResponseSchema = v.object({ id: v.string() });
const deleteResponseSchema = v.object({ deleted: v.boolean() });
const timerStartResponseSchema = v.object({
  id: v.string(),
  timerStartedAt: v.optional(v.string()),
});
const timerStopResponseSchema = v.object({
  billedMinutes: v.number(),
  durationMinutes: v.number(),
  id: v.string(),
});
const updatedResponseSchema = v.object({ updated: v.number() });
const splitResponseSchema = v.object({
  entryIds: v.array(v.string()),
  splitGroupId: v.string(),
});
const polishedNarrativeResponseSchema = v.object({ narrative: v.string() });

export type TimeEntry = v.InferOutput<typeof timeEntrySchema>;
export type TimeEntryListPage = v.InferOutput<typeof timeEntryListPageSchema>;
export type TimeEntrySummary = v.InferOutput<typeof timeEntrySummarySchema>;

const parse = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> | null => {
  const result = v.safeParse(schema, input);
  return result.success ? result.output : null;
};

export const parseTimeEntryListPage = (
  input: unknown,
): TimeEntryListPage | null => parse(timeEntryListPageSchema, input);

export const parseTimeEntrySummary = (
  input: unknown,
): TimeEntrySummary | null => parse(timeEntrySummarySchema, input);

export const parseTimeEntryIdResponse = (input: unknown) =>
  parse(idResponseSchema, input);

export const parseTimeEntryDeleteResponse = (input: unknown) =>
  parse(deleteResponseSchema, input);

export const parseTimerStartResponse = (input: unknown) =>
  parse(timerStartResponseSchema, input);

export const parseTimerStopResponse = (input: unknown) =>
  parse(timerStopResponseSchema, input);

export const parseTimeEntryUpdatedResponse = (input: unknown) =>
  parse(updatedResponseSchema, input);

export const parseTimeEntrySplitResponse = (input: unknown) =>
  parse(splitResponseSchema, input);

export const parsePolishedTimeEntryNarrativeResponse = (input: unknown) =>
  parse(polishedNarrativeResponseSchema, input);
