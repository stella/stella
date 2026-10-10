import * as v from "valibot";

export const desktopMatterSchema = v.strictObject({
  id: v.pipe(v.string(), v.maxLength(200)),
  name: v.pipe(v.string(), v.maxLength(1024)),
  reference: v.nullable(v.pipe(v.string(), v.maxLength(256))),
  color: v.nullable(v.pipe(v.string(), v.maxLength(64))),
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
  clientName: v.nullable(v.pipe(v.string(), v.maxLength(1024))),
  signals: v.strictObject({
    lastWorkedAt: v.nullable(v.pipe(v.string(), v.maxLength(64))),
    newlyAssignedAt: v.nullable(v.pipe(v.string(), v.maxLength(64))),
    upcomingDeadline: v.nullable(v.pipe(v.string(), v.maxLength(64))),
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
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.maxLength(200)),
        matterId: v.pipe(v.string(), v.maxLength(200)),
      }),
    ),
    v.minLength(1),
    v.maxLength(DESKTOP_ACTIVITY_REVIEW_LIMIT),
  ),
});
export type DesktopTimeEntryBatchResponse = v.InferOutput<
  typeof desktopTimeEntryBatchResponseSchema
>;

export const desktopTimeEntryBatchStatusRequestSchema = v.strictObject({
  idempotencyKey: desktopTimeEntryBatchSchema.entries.idempotencyKey,
});
export const DESKTOP_TIME_ENTRY_BATCH_STATUSES = [
  "committed",
  "cancelled",
] as const;
export const desktopTimeEntryBatchStatusSchema = v.variant("type", [
  v.strictObject({
    type: v.literal(DESKTOP_TIME_ENTRY_BATCH_STATUSES[0]),
    ...desktopTimeEntryBatchResponseSchema.entries,
  }),
  v.strictObject({
    type: v.literal(DESKTOP_TIME_ENTRY_BATCH_STATUSES[1]),
  }),
]);
export type DesktopTimeEntryBatchStatus = v.InferOutput<
  typeof desktopTimeEntryBatchStatusSchema
>;
