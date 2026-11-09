import type { fields } from "@/api/db/schema";

type FieldRow = typeof fields.$inferSelect;

/**
 * What every clone of a cell does with each `fields` column: a new file
 * version, a desktop edit, a restore, and a copy or move to another matter.
 *
 * - `minted`: the clone gets its own value.
 * - `target`: the clone takes the value of the version it is written into.
 * - `carried`: the clone keeps the source cell's value.
 * - `cleared`: the clone starts without it (a run's claim stays on the source).
 * - `derived`: the database computes it on insert.
 *
 * Total over the table, so a column added to `fields` does not compile until
 * it says what a clone does with it.
 */
const FIELD_CLONE_POLICY = {
  id: "minted",
  workspaceId: "target",
  entityVersionId: "target",
  propertyId: "carried",
  content: "carried",
  // A cell's settlement describes its content; the two travel together.
  aiSettlement: "carried",
  fileId: "cleared",
  ownerRunId: "cleared",
  ownerBatchId: "cleared",
  deadlineAt: "cleared",
  attempt: "cleared",
  entityFeatureGate: "derived",
  entityFeatureWorkspaceIds: "derived",
} as const satisfies Record<
  keyof FieldRow,
  "minted" | "target" | "carried" | "cleared" | "derived"
>;

type FieldClonePolicy = typeof FIELD_CLONE_POLICY;

type CarriedFieldColumn = {
  [Column in keyof FieldClonePolicy]: FieldClonePolicy[Column] extends "carried"
    ? Column
    : never;
}[keyof FieldClonePolicy];

/** The source columns a cell clone keeps. */
export type CarriedFieldColumns = Pick<FieldRow, CarriedFieldColumn>;

/** The relational-query selection that reads {@link CarriedFieldColumns}. */
export const CARRIED_FIELD_COLUMNS = {
  propertyId: true,
  content: true,
  aiSettlement: true,
} as const satisfies Record<CarriedFieldColumn, true>;

/** The carried values of one source cell, for a clone row to spread. */
export const carriedFieldValues = (
  field: CarriedFieldColumns,
): CarriedFieldColumns => ({
  propertyId: field.propertyId,
  content: field.content,
  aiSettlement: field.aiSettlement,
});
