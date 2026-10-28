/**
 * What one consolidation of a statute changed against the eligible
 * consolidation before it: the shape stored on the version row and the one
 * the versions list answers with. The counting itself is
 * `countStatuteChanges` in `@stll/legal-ast/statute-compare`, the same
 * comparison the reader draws side by side.
 */

import * as v from "valibot";

import type { StatuteChangeCounts } from "@stll/legal-ast/statute-compare";

/**
 * The counting a stored summary was computed with. Raise it when the
 * comparison or the counting changes: the backfill then recomputes every
 * summary written under an earlier one.
 */
export const STATUTE_VERSION_CHANGES_METHOD = 1;

/** The kinds of provision change a summary counts, in the order shown. */
export const STATUTE_PROVISION_CHANGE_KINDS = [
  "changed",
  "added",
  "removed",
] as const satisfies readonly (keyof StatuteChangeCounts["provisions"])[];

const countSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const statuteChangeCountsSchema = v.strictObject({
  provisions: v.strictObject({
    changed: countSchema,
    added: countSchema,
    removed: countSchema,
  }),
  words: v.strictObject({
    inserted: countSchema,
    deleted: countSchema,
  }),
}) satisfies v.GenericSchema<StatuteChangeCounts>;

const revisionSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/** The version a summary was compared against, as it stood then. */
const baseSchema = v.strictObject({
  documentId: v.pipe(v.string(), v.uuid()),
  payloadRevision: revisionSchema,
});

const provenance = {
  method: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  /** The summarised version's own payload revision when it was computed. */
  payloadRevision: revisionSchema,
};

/** Why a version with a predecessor has no counts. */
const STATUTE_VERSION_UNCOMPARED_REASONS = [
  /** One side has no structured text to align (no AST, or an empty one). */
  "no-blocks",
  /** One side's stored AST does not parse. */
  "unreadable",
  /** The comparison itself refused the pair. */
  "comparison-failed",
] as const;

/**
 * `change_summary` on a `legislation_documents` row. Every state names the
 * revisions it was computed from, so a summary outdated by a later write of
 * either version is recognisable and recomputed rather than served.
 */
export const storedStatuteVersionChangesSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("compared"),
    ...provenance,
    base: baseSchema,
    counts: statuteChangeCountsSchema,
  }),
  /** No eligible consolidation of the Work opens before this one. */
  v.strictObject({
    type: v.literal("first"),
    ...provenance,
  }),
  v.strictObject({
    type: v.literal("not-compared"),
    ...provenance,
    base: baseSchema,
    reason: v.picklist(STATUTE_VERSION_UNCOMPARED_REASONS),
  }),
]);

export type StoredStatuteVersionChanges = v.InferOutput<
  typeof storedStatuteVersionChangesSchema
>;

type ServedChangesOptions = {
  /** The column as stored; null until computed. */
  stored: unknown;
  /** The row's payload revision now. */
  payloadRevision: bigint;
};

/**
 * The counts a versions list may show for a row: a comparison computed from
 * the wording the row holds now, or nothing. A summary of an earlier payload,
 * or one that does not parse, is not shown; the backfill recomputes it.
 */
export const servedStatuteVersionChanges = ({
  payloadRevision,
  stored,
}: ServedChangesOptions): StatuteChangeCounts | null => {
  const parsed = v.safeParse(storedStatuteVersionChangesSchema, stored);
  if (!parsed.success || parsed.output.type !== "compared") {
    return null;
  }
  return BigInt(parsed.output.payloadRevision) === payloadRevision
    ? parsed.output.counts
    : null;
};
