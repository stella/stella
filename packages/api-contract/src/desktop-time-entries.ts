import * as v from "valibot";

export const desktopMatterSchema = v.strictObject({
  id: v.string(),
  name: v.string(),
  reference: v.nullable(v.string()),
  color: v.nullable(v.string()),
});

export type DesktopMatter = v.InferOutput<typeof desktopMatterSchema>;

export const desktopMattersResponseSchema = v.strictObject({
  matters: v.pipe(v.array(desktopMatterSchema), v.maxLength(20)),
});

export type DesktopMattersResponse = v.InferOutput<
  typeof desktopMattersResponseSchema
>;

export const DESKTOP_ACTIVITY_REVIEW_LIMIT = 100;
export const desktopMatterCandidateSchema = v.strictObject({
  ...desktopMatterSchema.entries,
  clientName: v.nullable(v.string()),
  signals: v.strictObject({
    lastWorkedAt: v.nullable(v.string()),
    newlyAssignedAt: v.nullable(v.string()),
    upcomingDeadline: v.nullable(v.string()),
  }),
});
export type DesktopTimeEntryMatterCandidate = v.InferOutput<
  typeof desktopMatterCandidateSchema
>;
export const desktopMatterCandidatesResponseSchema = v.strictObject({
  matters: v.pipe(
    v.array(desktopMatterCandidateSchema),
    v.maxLength(DESKTOP_ACTIVITY_REVIEW_LIMIT),
  ),
});
export type DesktopMatterCandidatesResponse = v.InferOutput<
  typeof desktopMatterCandidatesResponseSchema
>;

export const desktopTimeEntryBatchItemSchema = v.strictObject({
  matterId: v.pipe(v.string(), v.uuid()),
  dateWorked: v.pipe(v.string(), v.isoDate()),
  timezoneId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  durationMinutes: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(1440),
  ),
  narrative: v.pipe(v.string(), v.maxLength(10_000)),
  billable: v.boolean(),
});
export const desktopTimeEntryBatchSchema = v.strictObject({
  idempotencyKey: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  entries: v.pipe(
    v.array(desktopTimeEntryBatchItemSchema),
    v.minLength(1),
    v.maxLength(DESKTOP_ACTIVITY_REVIEW_LIMIT),
  ),
});
export type DesktopTimeEntryBatch = v.InferOutput<
  typeof desktopTimeEntryBatchSchema
>;
export const desktopTimeEntryBatchResponseSchema = v.strictObject({
  entries: v.pipe(
    v.array(v.strictObject({ id: v.string(), matterId: v.string() })),
    v.minLength(1),
    v.maxLength(DESKTOP_ACTIVITY_REVIEW_LIMIT),
  ),
});
export type DesktopTimeEntryBatchResponse = v.InferOutput<
  typeof desktopTimeEntryBatchResponseSchema
>;
