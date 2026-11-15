import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { corpusIndexProjectionStates } from "@/api/db/schema";
import { lockCorpusProjectionStatesByEntity } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  type DesiredStateKey,
  lockRegisteredCorpusProjectionManifestForMutation,
  retireServedCopiesTx,
  SERVED_COPY_RETIREMENT_REASONS,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { isRecord } from "@/api/lib/type-guards";

/** Where `retireLegacyUnprovenServedCopiesTx` resumes its walk. */
export type LegacyServedCopyRetireCursor = {
  indexId: string;
  /** `updated_at` as PostgreSQL renders it, at full precision. */
  updatedAt: string;
  entityId: string;
};

type RetireLegacyServedCopiesOptions = {
  family: CorpusFamily;
  generation: string;
  /** From this instant on every runner writes with this release. */
  cutoverAt: Temporal.Instant;
  after: LegacyServedCopyRetireCursor | null;
  limit: number;
};

const LEGACY_RETIRE_OUTCOMES = [
  "retired",
  "kept_one_change",
  "kept_same_content",
  "kept_after_cutover",
  "kept_not_applied",
  "kept_changed",
] as const;
type LegacyRetireOutcome = (typeof LEGACY_RETIRE_OUTCOMES)[number];

export type LegacyServedCopyRetirePage = {
  /** States this call read from the index. */
  scanned: number;
  /**
   * What became of each, by outcome: retired; kept because one change
   * separates the copy from the desired state, because the copy holds the
   * desired content, because the desired value was written at or after the
   * cutover, because the named revision is no longer `applied` (the cleanup
   * claim's to decide), or because the state changed since the page read it.
   */
  outcomes: Record<LegacyRetireOutcome, number>;
  /** Where the next call starts; `null` once the walk is complete. */
  next: LegacyServedCopyRetireCursor | null;
};

const LEGACY_RETIRE_MAX_PAGE = 512;

const requiredText = (row: unknown, key: string): string => {
  if (!isRecord(row) || typeof row[key] !== "string") {
    return panic(`Legacy retire row has no ${key}`);
  }
  return row[key];
};

/** `vanished`: states the page read that the locked read no longer found. */
const countOutcomes = (
  decided: readonly LegacyRetireOutcome[],
  vanished: number,
) => {
  const count = (outcome: LegacyRetireOutcome) =>
    decided.filter((decision) => decision === outcome).length;
  return {
    retired: count("retired"),
    kept_one_change: count("kept_one_change"),
    kept_same_content: count("kept_same_content"),
    kept_after_cutover: count("kept_after_cutover"),
    kept_not_applied: count("kept_not_applied"),
    kept_changed: count("kept_changed") + vanished,
  } satisfies Record<LegacyRetireOutcome, number>;
};

const requireOutcome = (value: string): LegacyRetireOutcome =>
  LEGACY_RETIRE_OUTCOMES.find((outcome) => outcome === value) ??
  panic(`Unknown legacy retire outcome: ${value}`);

/**
 * One page of the pass's walk over
 * `corpus_index_projection_states_replacement_route_idx`, whose predicate it
 * spells literally so the planner matches it. Exported so the plan guard
 * explains the exact statement the pass issues.
 */
export const legacyServedCopyRetirePageQuery = ({
  family,
  generation,
  after,
  limit,
}: Pick<
  RetireLegacyServedCopiesOptions,
  "family" | "generation" | "after" | "limit"
>) => sql`
  SELECT state.entity_id::text AS entity_id,
    state.desired_index_id AS index_id,
    state.updated_at::text AS updated_at
  FROM ${corpusIndexProjectionStates} state
  WHERE state.family = ${family}
    AND state.generation = ${generation}
    AND state.desired_action = 'upsert'
    AND state.applied_action = 'upsert'
    AND state.applied_revision IS NOT NULL
    AND state.applied_index_id IS NOT NULL
    AND state.desired_epoch > state.applied_epoch
    ${
      after === null
        ? sql``
        : sql`AND (state.desired_index_id, state.updated_at, state.entity_id)
            > (${after.indexId}, ${after.updatedAt}::timestamptz, ${after.entityId}::uuid)`
    }
  ORDER BY state.desired_index_id, state.updated_at, state.entity_id
  LIMIT ${limit}
`;

/**
 * A one-off pass over states an earlier release wrote. That release could undo
 * an erasure without retiring the copy the state still named, so a served copy
 * two or more desired epochs behind, holding other content than the state
 * desires, may be the pre-erasure one. This release retires such a copy
 * whenever it writes an undo itself, so the pass only needs the states whose
 * desired value was last written before every runner executed this release
 * (`cutoverAt`). A copy holding the desired content is kept whatever the gap.
 * The pass and its inputs are deleted in a later release once it has run in
 * every registered generation.
 *
 * It walks `corpus_index_projection_states_replacement_route_idx` in its key
 * order, one bounded page per call, and is resumable from the cursor it
 * returns. Each page is read unlocked, then its states are locked in entity
 * order and every decision is taken again under the lock.
 */
export const retireLegacyUnprovenServedCopiesTx = async (
  tx: Transaction,
  {
    family,
    generation,
    cutoverAt,
    after,
    limit,
  }: RetireLegacyServedCopiesOptions,
): Promise<LegacyServedCopyRetirePage> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > LEGACY_RETIRE_MAX_PAGE) {
    return panic("Legacy served-copy retire page size is invalid");
  }
  await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const states = corpusIndexProjectionStates;
  const page = executedRows(
    await tx.execute(
      legacyServedCopyRetirePageQuery({ family, generation, after, limit }),
    ),
  ).map((row) => ({
    entityId: requiredText(row, "entity_id"),
    indexId: requiredText(row, "index_id"),
    updatedAt: requiredText(row, "updated_at"),
  }));
  const last = page.at(-1);
  if (last === undefined) {
    return { scanned: 0, outcomes: countOutcomes([], 0), next: null };
  }
  const entityIds = page.map(({ entityId }) => entityId);
  await lockCorpusProjectionStatesByEntity(tx, {
    family,
    generation,
    entityIds,
  });
  const decided = executedRows(
    await tx.execute(sql`
      SELECT state.entity_id::text AS entity_id,
        CASE
          WHEN state.desired_action IS DISTINCT FROM 'upsert'
            OR state.applied_action IS DISTINCT FROM 'upsert'
            OR state.applied_revision IS NULL
            THEN 'kept_changed'
          WHEN named.status IS DISTINCT FROM 'applied'
            THEN 'kept_not_applied'
          WHEN state.desired_epoch < state.applied_epoch + 2
            THEN 'kept_one_change'
          WHEN (state.desired_fingerprint, state.desired_index_id)
            IS NOT DISTINCT FROM (state.applied_fingerprint, state.applied_index_id)
            THEN 'kept_same_content'
          WHEN state.desired_at IS NOT NULL
            AND state.desired_at >= ${cutoverAt.toString()}::timestamptz
            THEN 'kept_after_cutover'
          ELSE 'retired'
        END AS outcome
      FROM ${states} state
      LEFT JOIN corpus_index_projection_intents named
        ON named.id = state.applied_revision
      WHERE state.family = ${family}
        AND state.generation = ${generation}
        AND state.entity_id IN (${sql.join(
          entityIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
    `),
  ).map((row) => ({
    entityId: requiredText(row, "entity_id"),
    outcome: requireOutcome(requiredText(row, "outcome")),
  }));
  const retired: DesiredStateKey[] = decided.flatMap(({ entityId, outcome }) =>
    outcome === "retired" ? [{ family, generation, entityId }] : [],
  );
  await retireServedCopiesTx(
    tx,
    retired,
    SERVED_COPY_RETIREMENT_REASONS.legacyUnproven,
  );
  return {
    scanned: page.length,
    outcomes: countOutcomes(
      decided.map(({ outcome }) => outcome),
      page.length - decided.length,
    ),
    next:
      page.length < limit
        ? null
        : {
            indexId: last.indexId,
            updatedAt: last.updatedAt,
            entityId: last.entityId,
          },
  };
};
