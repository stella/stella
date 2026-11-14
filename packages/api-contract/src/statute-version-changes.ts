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
  /** Current eligible predecessor, from the same read as the target revision. */
  base: { documentId: string; payloadRevision: bigint } | null;
};

/** The shared provenance check used by repair planning and serving. */
export const currentStatuteVersionChanges = ({
  payloadRevision,
  stored,
  base,
}: ServedChangesOptions): StoredStatuteVersionChanges | null => {
  const parsed = v.safeParse(storedStatuteVersionChangesSchema, stored);
  if (!parsed.success) {
    return null;
  }
  const summary = parsed.output;
  if (
    summary.method !== STATUTE_VERSION_CHANGES_METHOD ||
    BigInt(summary.payloadRevision) !== payloadRevision
  ) {
    return null;
  }
  if (base === null) {
    return summary.type === "first" ? summary : null;
  }
  return summary.type !== "first" &&
    summary.base.documentId === base.documentId &&
    BigInt(summary.base.payloadRevision) === base.payloadRevision
    ? summary
    : null;
};

/** Counts require the current method and both current eligible endpoints. */
export const servedStatuteVersionChanges = (
  options: ServedChangesOptions,
): StatuteChangeCounts | null => {
  const current = currentStatuteVersionChanges(options);
  return current?.type === "compared" ? current.counts : null;
};
