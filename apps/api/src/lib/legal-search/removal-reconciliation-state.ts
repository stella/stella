import * as v from "valibot";

const uuid = v.pipe(v.string(), v.uuid());

export const removalCheckpointSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("running"),
    cursor: v.nullable(uuid),
    ceiling: uuid,
  }),
  v.strictObject({
    status: v.literal("waiting"),
    nextCycleAt: v.pipe(v.string(), v.isoTimestamp()),
  }),
]);

export type RemovalCheckpoint = v.InferOutput<typeof removalCheckpointSchema>;
