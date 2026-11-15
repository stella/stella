import { panic, Result, TaggedError } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawIndexJobs,
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

/**
 * A call resumed a walk under another cutover than the one it started with,
 * or from a cursor whose cutover is not an instant.
 */
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
   * `retired` then counts the copies a `retire` call would retire, and
   * `keptUnproven` the ones it would keep for want of evidence.
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
/** Every decision the pass takes per state: an outcome, or a counted keep. */
type LegacyRetireDecision =
  LegacyRetireOutcome | "kept_unproven" | "kept_blocked";

export type LegacyServedCopyRetirePage = {
  /** States this call read from the index. */
  scanned: number;
  /**
   * What became of each, by outcome: retired; kept because one change
   * separates the copy from the desired state, because the copy holds the
   * desired content, because the copy was applied, or fell two changes
   * behind, at or after the cutover, because the named revision is no
   * longer `applied` (the cleanup claim's to decide), or because the state
   * changed since the page read it; or skipped (`skipped_canonical_epoch`)
   * because the state's desired epoch no longer matches its canonical row,
   * so the state guard refuses every write of it (a generation that only
   * takes erasures keeps such states). A skipped state is not retried by this
   * walk. Together with `keptUnproven` and `keptBlocked`, every scanned
   * state is counted once.
   */
  outcomes: Record<LegacyRetireOutcome, number>;
  /**
   * Copies that met every condition for retirement except recorded evidence
   * of a withdrawal in the window: kept served, in both modes, and counted
   * here for the runner's report.
   */
  keptUnproven: number;
  /**
   * Copies with that evidence whose state's append is `blocked`: nothing
   * delivers a replacement until an operator unparks it, so retiring the
   * copy would leave the entity unserved. Kept served, in both modes, and
   * counted here for the runner's report.
   */
  keptBlocked: number;
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
  decided: readonly LegacyRetireDecision[],
  vanished: number,
) => {
  const count = (outcome: LegacyRetireDecision) =>
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

const requireDecision = (value: string): LegacyRetireDecision =>
  value === "kept_unproven" || value === "kept_blocked"
    ? value
    : (LEGACY_RETIRE_OUTCOMES.find((outcome) => outcome === value) ??
      panic(`Unknown legacy retire outcome: ${value}`));

/**
 * Recorded evidence that an erasure was written for the state's entity after
 * its named copy was reserved and before the cutover: a succeeded `withdraw`
 * row of the case-law index-job trail, the one durable per-decision record of
 * an erasure (`recordCorpusWithdrawalAuditEvent`, written in the same
 * transaction as the canonical change and its desired erasure).
 *
 * The window is `[named.created_at, cutover)`, on the row's `created_at`,
 * which is its transaction's start and so no later than the erasure it
 * records:
 * - From the copy's reservation: a copy is applied only while the desired
 *   state still equals it, so an erasure written before the reservation was
 *   undone before the copy's content was chosen, and the copy holds content
 *   desired after it. A withdrawal whose transaction began before the
 *   reservation and wrote its erasure after the apply falls outside the
 *   window and leaves the copy served, the safe direction.
 * - Up to the cutover: a withdrawal whose transaction began at or after it is
 *   this release's write, and the undo that follows it is this release's
 *   write too, which retires the copy itself (`readUndoneErasuresTx`).
 *
 * Legislation has no production writer of withdrawals, so this is never true
 * for legislation and the pass never retires a legislation copy.
 */
const erasureRecordedInWindow = (
  family: CorpusFamily,
  cutoverAt: Temporal.Instant,
): SQL => {
  const states = corpusIndexProjectionStates;
  const evidence = {
    case_law: sql`EXISTS (
      SELECT 1 FROM ${caseLawIndexJobs}
      WHERE ${caseLawIndexJobs.decisionId} = ${states.entityId}
        AND ${caseLawIndexJobs.operation} = 'withdraw'
        AND ${caseLawIndexJobs.status} = 'succeeded'
        AND ${caseLawIndexJobs.createdAt} >= named.created_at
        AND ${caseLawIndexJobs.createdAt} < ${cutoverAt.toString()}::timestamptz
    )`,
    legislation: sql`false`,
  } satisfies Record<CorpusFamily, SQL>;
  return evidence[family];
};

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
 * A one-off pass that retires a superseded copy a state still serves when an
 * erasure, later undone, is recorded between the copy and the cutover. A
 * candidate is a copy two or more desired epochs behind the desired state,
 * holding other content than the state desires, whose changes are not all
 * known to this release's desired writer (which retires the copy itself when
 * one of them undoes an erasure).
 *
 * What tells those changes apart is `desired_at`: an upsert write by this
 * release's desired writer leaves it unchanged once the named copy trails by
 * two changes with other content
 * (`corpusIndexProjectionNamedCopyTrailsTwoChanges`, judged on the row before
 * each write), so it keeps the instant the copy fell that far behind. If that
 * instant is at or after `cutoverAt`, the instant from which every runner
 * writes with this release, the undo of an erasure that moved the copy this
 * far behind was written by this release, which retired the copy then, so the
 * copy keeps serving. A `NULL` instant predates the column and counts as
 * before. A copy applied at or after the cutover keeps serving whatever the
 * instant: every change since its apply was written by this release. A copy
 * holding the desired content is kept whatever the gap.
 *
 * A candidate is retired only with recorded evidence of an erasure in its
 * window (`erasureRecordedInWindow`). Without it the pass cannot tell a
 * superseded copy from an ordinary pending replacement, and keeping a copy
 * served until its replacement lands is the safe direction, so the copy is
 * kept and counted in `keptUnproven`. Only case law records erasures that way;
 * the pass never retires a legislation copy. A candidate with evidence whose
 * append is `blocked` is kept too (`keptBlocked`): of the work statuses, only
 * `blocked` leaves the entity off every append queue, so retiring its copy
 * would leave it unserved with no replacement coming.
 *
 * The pass, the writer's rule and their inputs are deleted once the pass has
 * run in every registered generation.
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
  if (after !== null) {
    const cursorCutover = Result.try(() =>
      Temporal.Instant.from(after.cutoverAt),
    );
    if (
      Result.isError(cursorCutover) ||
      !cursorCutover.value.equals(cutoverAt)
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
      keptUnproven: 0,
      keptBlocked: 0,
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
          WHEN NOT ${erasureRecordedInWindow(family, cutoverAt)}
            THEN 'kept_unproven'
          WHEN ${states.workStatus} = 'blocked'
            THEN 'kept_blocked'
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
    outcome: requireDecision(requiredText(row, "outcome")),
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
    keptUnproven: decided.filter(({ outcome }) => outcome === "kept_unproven")
      .length,
    keptBlocked: decided.filter(({ outcome }) => outcome === "kept_blocked")
      .length,
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
