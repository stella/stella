/**
 * The row a decision analysis lives in, and the compare-and-swap that takes
 * it. Pure over a Drizzle handle: no env, no connection of its own, so the
 * API's background generation and an operator script running under a
 * restricted login both write through exactly the same statements.
 *
 * Every write is keyed by the input fingerprint as well as the decision:
 * the row may have been re-parsed since a run began, and a run's result or
 * sentinel cleanup must then leave the newer parse's state alone.
 */

import { panic, Result, type UnhandledException } from "better-result";
import {
  and,
  eq,
  or,
  type SQL,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";

import type {
  AnalysisGenerating,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";

import type { Transaction } from "@/api/db/root";
import { caseLawAnalysisFailures, caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { redactedProviderDiagnostic } from "@/api/lib/errors/redacted-provider-diagnostic";

import {
  ANALYSIS_FAILURE_HOLD_MS,
  type AnalysisFailureRecord,
  type FailureClaimGuard,
} from "./analysis-failure";
import {
  analysisSentinel,
  type AnalysisStoreKey,
  claimableAnalysisRowFor,
  storedAnalysisFingerprintFor,
} from "./stored-analysis";

/**
 * The Drizzle capabilities the store needs. Structural rather than a
 * concrete handle, so a script's own connection (or another driver's
 * handle) satisfies it without the store reaching for the application's.
 * `execute` is typed by what the store needs of it, a statement run for its
 * effect: its result's shape differs between drivers, and no caller reads it.
 */
type AnalysisRowWriter = Pick<Transaction, "select" | "update"> & {
  execute: (statement: SQL) => PromiseLike<unknown>;
};

/** The claim transaction's handle: the row writer, able to roll back its swap. */
type AnalysisClaimTransaction = AnalysisRowWriter &
  Pick<Transaction, "rollback">;

/**
 * The store's handle: the row writer, able to open the claim's transaction.
 * Stated over the callback's handle rather than picked from `Transaction`,
 * whose callback is typed to one driver.
 */
export type AnalysisClaimWriter = AnalysisRowWriter & {
  transaction: <Value>(
    run: (tx: AnalysisClaimTransaction) => Promise<Value>,
  ) => Promise<Value>;
};

type AnalysisClaim = AnalysisStoreKey & {
  /** The stored value this caller read and found wanting; see `claimableAnalysisRow`. */
  observed: unknown;
};

type GuardedAnalysisClaim = AnalysisClaim & {
  /** This reader's key: an applicable failure under it refuses the claim. */
  unlessFailed: FailureClaimGuard;
};

type AnalysisOwnership =
  | { type: "generation"; sentinel: AnalysisGenerating }
  | { type: "revision"; expected: DecisionAnalysis };

type AnalysisSave = {
  decisionId: SafeId<"caseLawDecision">;
  analysis: DecisionAnalysis;
  /** The row's content hash when the input was read. */
  contentHash: string | null;
  /** A streaming claim uses run identity; a revision replaces the exact finished value. */
  ownership: AnalysisOwnership;
};

type AnalysisRelease = {
  decisionId: SafeId<"caseLawDecision">;
  /** The sentinel `claim` returned to this run. */
  sentinel: AnalysisGenerating;
};

type AnalysisPartialSave = AnalysisRelease & {
  partialTree: DecisionAnalysis["tree"];
};

type AnalysisFailureKey = {
  decisionId: SafeId<"caseLawDecision">;
  /** The reader key the failure is filed under (`analysisFailureKeyTag`). */
  keyTag: string;
};

type AnalysisFailure = AnalysisRelease & {
  keyTag: string;
  /** Over the sentinel's own input, which the store does not re-derive. */
  failure: AnalysisFailureRecord;
};

/**
 * Expired failure records swept by each failure write, oldest first: enough
 * to keep pace with the writes that add them, bounded so a write never scans.
 */
const FAILURE_SWEEP_BATCH = 50;

export type AnalysisStore = {
  /**
   * Takes the row for a run over `fingerprint`, provided it still holds
   * `observed`. Returns the sentinel it wrote, which is the run's
   * identity from here on; null when another writer got there first.
   */
  claim: (claim: AnalysisClaim) => Promise<AnalysisGenerating | null>;
  /**
   * A reader's claim: `claim`, also refused (null) while this reader's key
   * has a failure the guard applies (see `FailureClaimGuard`; an explicit
   * retry is refused only before the provider's retry time). A writer that
   * submits a finished analysis uses `claim`. Fails with the database error
   * that ended the claim's transaction.
   */
  claimUnlessFailed: (
    claim: GuardedAnalysisClaim,
  ) => Promise<Result<AnalysisGenerating | null, UnhandledException>>;
  /**
   * Stores the result, only where the row still carries this run's
   * fingerprint and the document it was claimed under. A re-parse during
   * the run changes `contentHash`; the result would then be rejected by
   * the next read anyway, so it is not worth the write.
   *
   * Answers whether a row was actually written. A caller that reports its
   * own success must ask: the fences are `WHERE` clauses, so a row that
   * moved between the claim and the save is a silent no-op otherwise.
   */
  save: (save: AnalysisSave) => Promise<boolean>;
  /** Publishes complete streamed sections while this run still owns the row. */
  savePartial: (save: AnalysisPartialSave) => Promise<boolean>;
  /**
   * Releases this run's sentinel, and only this run's: the exact value
   * `claim` wrote. A replacement run that took over this one's stale
   * sentinel holds a different value and is left alone.
   */
  clear: (release: AnalysisRelease) => Promise<void>;
  /**
   * Releases this run's sentinel and, in the same statement, records how the
   * run failed under its reader's key; a run that no longer holds its
   * sentinel writes neither. The record sits apart from the shared row, so another reader's
   * run on the same decision neither replaces nor clears it: the reader whose
   * key failed is told so until it asks to run again, while every other
   * reader runs with its own key.
   */
  fail: (failure: AnalysisFailure) => Promise<void>;
  /** The failure last recorded under this reader key, if any. */
  readFailure: (
    key: AnalysisFailureKey,
  ) => Promise<AnalysisFailureRecord | null>;
  /** What the store holds beside the row; null where the row is the store. */
  peek: (decisionId: SafeId<"caseLawDecision">) => unknown;
};

/**
 * How a run gives the row back: its exact sentinel, and only that, becomes
 * nothing. A replacement run that took over a stale sentinel holds a
 * different value and is left alone.
 *
 * A failed run files its failure in the same statement that releases the
 * sentinel, and only when that release takes: a run whose sentinel was
 * superseded (a re-parse, a takeover) writes nothing, so it can never
 * overwrite the failure of the run that replaced it with an older input. One
 * statement, so no poll sees the row released without the failure filed.
 * Then a bounded batch of expired records is swept.
 */
const releaseRun = async (
  db: AnalysisRowWriter,
  {
    decisionId,
    sentinel,
    failure,
  }: AnalysisRelease & {
    failure?: { keyTag: string; record: AnalysisFailureRecord } | undefined;
  },
): Promise<void> => {
  // audit: skip — analysis run bookkeeping; no user-facing record changes
  if (failure === undefined) {
    await db
      .update(caseLawDecisions)
      .set({ analysis: null })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          // `::text::jsonb`, never a bare `::jsonb` (see `claimableAnalysisRow`).
          sql`${caseLawDecisions.analysis}->>'status' = 'generating'`,
          sql`${caseLawDecisions.analysis}->>'runId' = ${sentinel.runId}`,
          sql`${storedAnalysisFingerprintFor(caseLawDecisions)} = ${sentinel.inputFingerprint}`,
        ),
      );
    return;
  }
  const { keyTag, record } = failure;
  const recordedAt = record.recordedAt.toISOString();
  // `::text::jsonb`, never a bare `::jsonb` (see `claimableAnalysisRow`).
  await db.execute(sql`
    WITH released AS (
      UPDATE "case_law_decisions" SET "analysis" = NULL
      WHERE "id" = ${decisionId}::uuid
        AND "analysis"->>'status' = 'generating'
        AND "analysis"->>'runId' = ${sentinel.runId}
        AND "analysis"->>'inputFingerprint' = ${sentinel.inputFingerprint}
      RETURNING "id"
    )
    INSERT INTO "case_law_analysis_failures"
      ("decision_id", "key_tag", "input_fingerprint", "code", "key_source", "provider", "recorded_at", "retry_after", "provider_diagnostic")
    SELECT "id", ${keyTag}, ${record.inputFingerprint}, ${record.code},
      ${record.keySource}, ${record.provider}, ${recordedAt}::timestamptz,
      ${record.retryAfter === undefined ? null : record.retryAfter.toISOString()}::timestamptz,
      ${record.providerDiagnostic === undefined ? null : JSON.stringify(record.providerDiagnostic)}::text::jsonb
    FROM released
    ON CONFLICT ("decision_id", "key_tag") DO UPDATE SET
      "input_fingerprint" = EXCLUDED."input_fingerprint",
      "code" = EXCLUDED."code",
      "key_source" = EXCLUDED."key_source",
      "provider" = EXCLUDED."provider",
      "recorded_at" = EXCLUDED."recorded_at",
      "retry_after" = EXCLUDED."retry_after",
      "provider_diagnostic" = EXCLUDED."provider_diagnostic"
  `);
  const expiredBefore = new Date(
    record.recordedAt.getTime() - ANALYSIS_FAILURE_HOLD_MS,
  ).toISOString();
  // A record is expired once its hold has passed and so has any retry time
  // its provider named, which may lie well beyond the hold.
  const expired = sql`"recorded_at" < ${expiredBefore}::timestamptz
    AND ("retry_after" IS NULL OR "retry_after" <= ${recordedAt}::timestamptz)`;
  // The expiry is checked on the deleted row itself as well as in the
  // candidate subquery. A candidate another writer refreshed while this
  // statement waited on its lock is rechecked against the outer condition
  // only, so without it the fresh record would be deleted by its key.
  await db.execute(sql`
    DELETE FROM "case_law_analysis_failures"
    WHERE ("decision_id", "key_tag") IN (
        SELECT "decision_id", "key_tag" FROM "case_law_analysis_failures"
        WHERE ${expired}
        ORDER BY "recorded_at" LIMIT ${FAILURE_SWEEP_BATCH}
      )
      AND ${expired}
  `);
};

/** The claim's compare-and-swap: the row becomes `sentinel` if it still holds `observed`. */
const swapAnalysisRow = async (
  handle: AnalysisRowWriter,
  {
    decisionId,
    observed,
    sentinel,
  }: Omit<AnalysisClaim, "fingerprint"> & { sentinel: AnalysisGenerating },
): Promise<AnalysisGenerating | null> => {
  // audit: skip — analysis sentinel; the caller audits the analysis it saves
  const [updated] = await handle
    .update(caseLawDecisions)
    .set({ analysis: sentinel })
    .where(claimableAnalysisRowFor(caseLawDecisions, { decisionId, observed }))
    .returning({ id: caseLawDecisions.id });
  return updated === undefined ? null : sentinel;
};

/** Test seams; never set outside tests. */
type AnalysisStoreHooks = {
  /** Runs inside a plain claim, after its swap took the row lock and before the failure read. */
  afterClaimLock?: ((tx: AnalysisRowWriter) => Promise<void>) | undefined;
};

const ownedGenerationRow = (sentinel: AnalysisGenerating) =>
  and(
    sql`${caseLawDecisions.analysis}->>'status' = 'generating'`,
    sql`${caseLawDecisions.analysis}->>'runId' = ${sentinel.runId}`,
    sql`${storedAnalysisFingerprintFor(caseLawDecisions)} = ${sentinel.inputFingerprint}`,
  );

type AnalysisWrite =
  | { type: "complete"; save: AnalysisSave }
  | { type: "partial"; save: AnalysisPartialSave };

const writeAnalysisRow = async (
  db: AnalysisRowWriter,
  write: AnalysisWrite,
) => {
  const update = (() => {
    switch (write.type) {
      case "partial":
        return {
          analysis: {
            ...write.save.sentinel,
            partialTree: write.save.partialTree,
          },
          conditions: [ownedGenerationRow(write.save.sentinel)],
        };
      case "complete": {
        const { analysis, contentHash, ownership } = write.save;
        const owner = (() => {
          switch (ownership.type) {
            case "generation":
              return ownedGenerationRow(ownership.sentinel);
            case "revision":
              // text-to-jsonb keeps parameter inference identical to claimableAnalysisRow.
              return sql`${caseLawDecisions.analysis} = ${JSON.stringify(ownership.expected)}::text::jsonb`;
            default:
              ownership satisfies never;
              return panic("Unknown analysis write ownership");
          }
        })();
        return {
          analysis,
          conditions: [
            sql`${storedAnalysisFingerprintFor(caseLawDecisions)} = ${analysis.inputFingerprint}`,
            sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${contentHash}`,
            owner,
          ],
        };
      }
      default:
        write satisfies never;
        return panic("Unknown analysis write phase");
    }
  })();
  // audit: skip - callers audit completed analyses; partial rows are ephemeral progress
  const written = await db
    .update(caseLawDecisions)
    .set({ analysis: update.analysis })
    .where(
      and(eq(caseLawDecisions.id, write.save.decisionId), ...update.conditions),
    )
    .returning({ id: caseLawDecisions.id });
  return written.length > 0;
};

/**
 * The row-backed store. Its claim, save and release touch one column of one
 * table, which is exactly what the restricted analysis-writer role is
 * granted; only a failed run's record reaches a second table, which only the
 * owner connection that runs the analysis may write.
 */
export const createDbAnalysisStore = (
  db: AnalysisClaimWriter,
  hooks: AnalysisStoreHooks = {},
): AnalysisStore => ({
  claim: async ({ decisionId, fingerprint, observed }) =>
    await swapAnalysisRow(db, {
      decisionId,
      observed,
      sentinel: analysisSentinel(fingerprint, new Date()),
    }),
  claimUnlessFailed: async ({
    decisionId,
    fingerprint,
    observed,
    unlessFailed,
  }) => {
    const sentinel = analysisSentinel(fingerprint, new Date());
    // A guarded claim, in one short transaction. Under READ COMMITTED a guard
    // folded into the UPDATE would read failures from the statement's own
    // snapshot, and a concurrent failure write (which releases the row and
    // files the failure in one statement, under this row's lock) would then
    // be rechecked on the row alone. So the compare-and-swap goes first: it
    // takes the row lock, waiting for any such write to commit. The failure
    // read that follows is a new statement with a fresh snapshot, so it sees
    // what that write filed, and an applicable failure rolls the swap back.
    // The swap is the lock: the aggregate-lock owner confines explicit
    // `FOR UPDATE` reads, and an UPDATE of this one row needs none.
    const outcome = await Result.tryPromise(
      async () =>
        await withAggregateTransaction(db, async (tx) => {
          const claimed = await swapAnalysisRow(tx, {
            decisionId,
            observed,
            sentinel,
          });
          if (claimed === null) {
            return null;
          }
          await hooks.afterClaimLock?.(tx);
          const [failure] = await tx
            .select({ keyTag: caseLawAnalysisFailures.keyTag })
            .from(caseLawAnalysisFailures)
            .where(
              and(
                eq(caseLawAnalysisFailures.decisionId, decisionId),
                eq(caseLawAnalysisFailures.keyTag, unlessFailed.keyTag),
                eq(caseLawAnalysisFailures.inputFingerprint, fingerprint),
                eq(caseLawAnalysisFailures.keySource, unlessFailed.keySource),
                sql`${caseLawAnalysisFailures.provider} IS NOT DISTINCT FROM ${unlessFailed.provider}`,
                // The same hold as `failureMatchesGuard`.
                or(
                  sql`${caseLawAnalysisFailures.retryAfter} > ${unlessFailed.now.toISOString()}::timestamptz`,
                  ...(unlessFailed.heldSince === null
                    ? []
                    : [
                        sql`${caseLawAnalysisFailures.recordedAt} > ${unlessFailed.heldSince.toISOString()}::timestamptz`,
                      ]),
                ),
              ),
            )
            .limit(1);
          if (failure !== undefined) {
            tx.rollback();
          }
          return claimed;
        }),
    );
    // The refusal's rollback is an answer, not a failure.
    if (
      Result.isError(outcome) &&
      outcome.error.cause instanceof TransactionRollbackError
    ) {
      return Result.ok(null);
    }
    return outcome;
  },
  save: async (save) => await writeAnalysisRow(db, { type: "complete", save }),
  savePartial: async (save) =>
    await writeAnalysisRow(db, { type: "partial", save }),
  clear: async ({ decisionId, sentinel }) => {
    await releaseRun(db, { decisionId, sentinel });
  },
  fail: async ({ decisionId, failure, keyTag, sentinel }) => {
    if (failure.inputFingerprint !== sentinel.inputFingerprint) {
      panic("A failure record must be over its run's own input");
    }
    await releaseRun(db, {
      decisionId,
      sentinel,
      failure: { keyTag, record: failure },
    });
  },
  readFailure: async ({ decisionId, keyTag }) => {
    const [row] = await db
      .select({
        code: caseLawAnalysisFailures.code,
        inputFingerprint: caseLawAnalysisFailures.inputFingerprint,
        keySource: caseLawAnalysisFailures.keySource,
        provider: caseLawAnalysisFailures.provider,
        recordedAt: caseLawAnalysisFailures.recordedAt,
        retryAfter: caseLawAnalysisFailures.retryAfter,
        providerDiagnostic: caseLawAnalysisFailures.providerDiagnostic,
      })
      .from(caseLawAnalysisFailures)
      .where(
        and(
          eq(caseLawAnalysisFailures.decisionId, decisionId),
          eq(caseLawAnalysisFailures.keyTag, keyTag),
        ),
      )
      .limit(1);
    if (row === undefined) {
      return null;
    }
    const { providerDiagnostic, retryAfter, ...failure } = row;
    return {
      ...failure,
      ...(retryAfter === null ? {} : { retryAfter }),
      ...(providerDiagnostic === null
        ? {}
        : {
            providerDiagnostic: redactedProviderDiagnostic(providerDiagnostic),
          }),
    };
  },
  peek: () => null,
});
