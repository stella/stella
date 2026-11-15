import { panic, Result, TaggedError } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  corpusIndexProjectionStates,
  legislationDocuments,
} from "@/api/db/schema";
import { lockCorpusProjectionStatesByEntity } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  type DesiredStateKey,
  lockRegisteredCorpusProjectionManifestForMutation,
  retireServedCopiesTx,
  SERVED_COPY_RETIREMENT_REASONS,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { corpusIndexProjectionNamedCopyTrailsTwoChanges } from "@/api/lib/legal-search/corpus-index-projection-sql";
import { isRecord } from "@/api/lib/type-guards";

/** Where `retireLegacyUnprovenServedCopiesTx` resumes its walk. */
export type LegacyServedCopyRetireCursor = {
  /**
   * The cutover the walk decides by, as an ISO instant. A walk is only
   * consistent under one cutover, so a call resuming from this cursor must
   * pass the same one.
   */
  cutoverAt: string;
  indexId: string;
  /** `updated_at` as PostgreSQL renders it, at full precision. */
  updatedAt: string;
  entityId: string;
};

/** A call resumed a walk under another cutover than the one it started with. */
export class LegacyServedCopyRetireCutoverMismatchError extends TaggedError(
  "LegacyServedCopyRetireCutoverMismatchError",
)<{ message: string; cursorCutoverAt: string; cutoverAt: string }> {}

type RetireLegacyServedCopiesOptions = {
  family: CorpusFamily;
  generation: string;
  /**
   * From this instant on every runner writes with this release. The pass
   * refuses an instant later than the database clock, and a cursor that was
   * returned under another instant.
   */
  cutoverAt: Temporal.Instant;
  after: LegacyServedCopyRetireCursor | null;
  limit: number;
  /**
   * `count` decides every state exactly as `retire` would and writes nothing:
   * `retired` then counts the copies a `retire` call would retire.
   */
  mode: "retire" | "count";
};

const LEGACY_RETIRE_OUTCOMES = [
  "retired",
  "kept_one_change",
  "kept_same_content",
  "kept_after_cutover",
  "kept_not_applied",
  "kept_changed",
  "skipped_canonical_epoch",
] as const;
type LegacyRetireOutcome = (typeof LEGACY_RETIRE_OUTCOMES)[number];

export type LegacyServedCopyRetirePage = {
  /** States this call read from the index. */
  scanned: number;
  /**
   * What became of each, by outcome: retired; kept because one change
   * separates the copy from the desired state, because the copy holds the
   * desired content, because the copy was applied, or fell two changes
   * behind, at or after the cutover, because the named revision is no longer `applied` (the
   * cleanup claim's to decide), or because the state changed since the page
   * read it; or skipped (`skipped_canonical_epoch`) because the state's
   * desired epoch no longer matches its canonical row, so the state guard
   * refuses every write of it (a generation that only takes erasures keeps
   * such states). A skipped state is not retried by this walk.
   */
  outcomes: Record<LegacyRetireOutcome, number>;
  /** The skipped states, for the runner's log. */
  skipped: readonly { entityId: string; reason: "canonical_epoch" }[];
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

/** `vanished`: states the page read that the decision read no longer found. */
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
    skipped_canonical_epoch: count("skipped_canonical_epoch"),
  } satisfies Record<LegacyRetireOutcome, number>;
};

const requireOutcome = (value: string): LegacyRetireOutcome =>
  LEGACY_RETIRE_OUTCOMES.find((outcome) => outcome === value) ??
  panic(`Unknown legacy retire outcome: ${value}`);

/** The canonical epoch the state guard compares each state with. */
const canonicalProjectionEpoch = (family: CorpusFamily) => {
  const states = corpusIndexProjectionStates;
  const epochs = {
    case_law: sql`(SELECT ${caseLawDecisions.projectionEpoch} FROM ${caseLawDecisions}
      WHERE ${caseLawDecisions.id} = ${states.entityId})`,
    legislation: sql`(SELECT ${legislationDocuments.projectionEpoch} FROM ${legislationDocuments}
      WHERE ${legislationDocuments.id} = ${states.entityId})`,
  } satisfies Record<CorpusFamily, SQL>;
  return epochs[family];
};

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
}: Pick<RetireLegacyServedCopiesOptions, "family" | "generation" | "limit"> & {
  /** The walk's key; the cutover a cursor carries does not narrow the page. */
  after: Omit<LegacyServedCopyRetireCursor, "cutoverAt"> | null;
}) => sql`
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
 * A one-off pass that retires a superseded copy a state still serves when it
 * is not provably current: two or more desired epochs separate it from the
 * desired state, it holds other content than the state desires, and the
 * changes that separate it are not all known to this release's desired
 * writer, which retires the copy itself when one of them undoes an erasure.
 *
 * What tells them apart is `desired_at`: an upsert write by this release's
 * desired writer leaves it unchanged once the named copy trails by two changes
 * with other content (`corpusIndexProjectionNamedCopyTrailsTwoChanges`, judged
 * on the row before each write), so it keeps the instant the copy fell that
 * far behind. If that instant precedes `cutoverAt`, the instant from which
 * every runner writes with this release, the copy is retired, however often
 * this release has written the state since (an epoch-only reconciliation or a
 * ranking-signal re-projection included). If it is at or after the cutover,
 * the undo of an erasure that moved the copy this far behind was written by
 * this release, which retired the copy then, so the copy keeps serving. A
 * `NULL` instant predates the column and counts as before. A copy applied at
 * or after the cutover keeps serving whatever the instant: every change since
 * its apply was written by this release. A copy holding the desired content
 * is kept whatever the gap. The pass, the writer's rule and their inputs are
 * deleted once the pass has run in every registered generation.
 *
 * It walks `corpus_index_projection_states_replacement_route_idx` in its key
 * order, one bounded page per call, and is resumable from the cursor it
 * returns. Each page is read unlocked, then (in `retire` mode) its states are
 * locked in entity order and every decision is taken again under the lock.
 */
export const retireLegacyUnprovenServedCopiesTx = async (
  tx: Transaction,
  {
    family,
    generation,
    cutoverAt,
    after,
    limit,
    mode,
  }: RetireLegacyServedCopiesOptions,
): Promise<
  Result<LegacyServedCopyRetirePage, LegacyServedCopyRetireCutoverMismatchError>
> => {
  if (!Number.isInteger(limit) || limit < 1 || limit > LEGACY_RETIRE_MAX_PAGE) {
    return panic("Legacy served-copy retire page size is invalid");
  }
  if (
    after !== null &&
    !Temporal.Instant.from(after.cutoverAt).equals(cutoverAt)
  ) {
    return Result.err(
      new LegacyServedCopyRetireCutoverMismatchError({
        message:
          "Legacy served-copy retire resumed under another cutover than its cursor",
        cursorCutoverAt: after.cutoverAt,
        cutoverAt: cutoverAt.toString(),
      }),
    );
  }
  const cutover = sql`${cutoverAt.toString()}::timestamptz`;
  const [clock] = executedRows(
    await tx.execute(sql`
      SELECT (${cutover} <= clock_timestamp())::text AS cutover_has_passed
    `),
  );
  if (requiredText(clock, "cutover_has_passed") !== "true") {
    return panic("Legacy served-copy cutover is later than the database clock");
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
    return Result.ok({
      scanned: 0,
      outcomes: countOutcomes([], 0),
      skipped: [],
      next: null,
    });
  }
  const entityIds = page.map(({ entityId }) => entityId);
  if (mode === "retire") {
    await lockCorpusProjectionStatesByEntity(tx, {
      family,
      generation,
      entityIds,
    });
  }
  const trailsTwoChanges = corpusIndexProjectionNamedCopyTrailsTwoChanges({
    desiredAction: states.desiredAction,
    appliedAction: states.appliedAction,
    appliedRevision: states.appliedRevision,
    appliedEpoch: states.appliedEpoch,
    desiredEpoch: states.desiredEpoch,
    appliedFingerprint: states.appliedFingerprint,
    desiredFingerprint: states.desiredFingerprint,
    appliedIndexId: states.appliedIndexId,
    desiredIndexId: states.desiredIndexId,
  });
  const decided = executedRows(
    await tx.execute(sql`
      SELECT ${states.entityId}::text AS entity_id,
        CASE
          WHEN ${states.desiredAction} IS DISTINCT FROM 'upsert'
            OR ${states.appliedAction} IS DISTINCT FROM 'upsert'
            OR ${states.appliedRevision} IS NULL
            THEN 'kept_changed'
          WHEN named.status IS DISTINCT FROM 'applied'
            THEN 'kept_not_applied'
          WHEN ${states.desiredEpoch} < ${states.appliedEpoch} + 2
            THEN 'kept_one_change'
          WHEN NOT ${trailsTwoChanges}
            THEN 'kept_same_content'
          WHEN (${states.desiredAt} IS NOT NULL
              AND ${states.desiredAt} >= ${cutover})
            OR named.applied_at >= ${cutover}
            THEN 'kept_after_cutover'
          WHEN ${canonicalProjectionEpoch(family)} IS DISTINCT FROM ${states.desiredEpoch}
            THEN 'skipped_canonical_epoch'
          ELSE 'retired'
        END AS outcome
      FROM ${states}
      LEFT JOIN corpus_index_projection_intents named
        ON named.id = ${states.appliedRevision}
      WHERE ${states.family} = ${family}
        AND ${states.generation} = ${generation}
        AND ${states.entityId} IN (${sql.join(
          entityIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
    `),
  ).map((row) => ({
    entityId: requiredText(row, "entity_id"),
    outcome: requireOutcome(requiredText(row, "outcome")),
  }));
  if (mode === "retire") {
    const retired: DesiredStateKey[] = decided.flatMap(
      ({ entityId, outcome }) =>
        outcome === "retired" ? [{ family, generation, entityId }] : [],
    );
    await retireServedCopiesTx(
      tx,
      retired,
      SERVED_COPY_RETIREMENT_REASONS.legacyUnproven,
    );
  }
  return Result.ok({
    scanned: page.length,
    outcomes: countOutcomes(
      decided.map(({ outcome }) => outcome),
      page.length - decided.length,
    ),
    skipped: decided.flatMap(({ entityId, outcome }) =>
      outcome === "skipped_canonical_epoch"
        ? [{ entityId, reason: "canonical_epoch" as const }]
        : [],
    ),
    next:
      page.length < limit
        ? null
        : {
            cutoverAt: cutoverAt.toString(),
            indexId: last.indexId,
            updatedAt: last.updatedAt,
            entityId: last.entityId,
          },
  });
};
