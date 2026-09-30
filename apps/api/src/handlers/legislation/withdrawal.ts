import { panic } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import type { LEGISLATION_WINDOW_DISPOSITION_BASES } from "@stll/api-contract/legislation-expression";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import { declareWriterContract } from "@/api/handlers/legislation/ingestion";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { stripDangerousChars } from "@/api/lib/legal-search/corpus-sanitize";

/**
 * Withdrawing stored legislation versions: the tombstone a census writes for
 * a version its publisher no longer lists. The row keeps its UUID, its window
 * and its payload, so it stays openable by id and a later live listing
 * restores it in place (`processLegislationDocument`); no read may treat it
 * as in force and no search may find it.
 */

/** Why a stored version is withdrawn. */
type LegislationWithdrawalBasis =
  (typeof LEGISLATION_WINDOW_DISPOSITION_BASES)["withdrawn"][number];

/** The most withdrawals one call applies. */
export const LEGISLATION_WITHDRAWAL_BATCH_LIMIT = 100;

/** One stored version to withdraw, as the census observed it. */
export type LegislationWithdrawal = {
  sourceId: SafeId<"legislationSource">;
  eli: string;
  language: string;
  /** The version's `publisher_expression_id`: withdrawal is by id only. */
  publisherId: string;
  basis: LegislationWithdrawalBasis;
  /**
   * The row's `payload_revision` and `source_hash` when the census read it.
   * The withdrawal applies only while the row still carries both, so it
   * cannot overwrite a write that changed the row after that read: a changed
   * payload or window moves the revision, and a changed field of any other
   * kind moves the hash. A re-observation that changed nothing writes nothing
   * and cannot be told apart; the census's own listing has to exclude it.
   */
  observedPayloadRevision: bigint;
  observedSourceHash: string | null;
};

type LegislationWithdrawalOutcome =
  /** Withdrawn now; its search projection is erased with it. */
  | { type: "withdrawn"; id: SafeId<"legislationDocument"> }
  /** Already withdrawn on this basis: a replayed withdrawal. */
  | { type: "unchanged"; id: SafeId<"legislationDocument"> }
  /** The row changed after the census read it; nothing was written. */
  | {
      type: "stale";
      id: SafeId<"legislationDocument">;
      payloadRevision: bigint;
      sourceHash: string | null;
    }
  /** No stored version carries the id. */
  | { type: "missing" };

/**
 * The stored version a withdrawal names. Bounded by its work: every key but
 * the id is the work's, reached through the identifier's index.
 */
export const withdrawalTargetQuery = (
  tx: Transaction,
  withdrawal: Pick<
    LegislationWithdrawal,
    "sourceId" | "eli" | "language" | "publisherId"
  >,
) =>
  tx
    .select({ id: legislationDocuments.id })
    .from(legislationDocuments)
    .where(
      and(
        eq(legislationDocuments.eli, withdrawal.eli),
        eq(legislationDocuments.sourceId, withdrawal.sourceId),
        eq(legislationDocuments.language, withdrawal.language),
        eq(legislationDocuments.publisherExpressionId, withdrawal.publisherId),
      ),
    )
    // Deterministic should a duplicate ever exist.
    .orderBy(asc(legislationDocuments.id))
    .limit(1);

/**
 * Withdraw the version the lookup found, and bring its desired search
 * projection to the erase in the same transaction: nothing later re-derives
 * it, so a withdrawal committed without it would stay searchable. A version
 * gone since the lookup is `missing`, like one never stored.
 */
const withdrawTarget = async (
  tx: Transaction,
  id: SafeId<"legislationDocument">,
  withdrawal: LegislationWithdrawal,
): Promise<LegislationWithdrawalOutcome> => {
  await declareWriterContract(tx);
  const subject = { family: "legislation", entityId: id } as const;
  // The source before the row, in the order every legislation writer takes
  // them. The source is locked by its id, so a version deleted since the
  // lookup is found missing by the row lock below instead of failing here.
  const projectionLock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
    family: "legislation",
    sourceId: withdrawal.sourceId,
  });
  const row = (
    await tx
      .select({
        payloadRevision: legislationDocuments.payloadRevision,
        sourceHash: legislationDocuments.sourceHash,
        windowDisposition: legislationDocuments.windowDisposition,
        windowDispositionBasis: legislationDocuments.windowDispositionBasis,
      })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, id))
      .for("update")
  ).at(0);
  if (row === undefined) {
    return { type: "missing" };
  }
  const replayed =
    row.windowDisposition === "withdrawn" &&
    row.windowDispositionBasis === withdrawal.basis;
  if (
    !replayed &&
    (row.payloadRevision !== withdrawal.observedPayloadRevision ||
      row.sourceHash !== withdrawal.observedSourceHash)
  ) {
    return {
      type: "stale",
      id,
      payloadRevision: row.payloadRevision,
      sourceHash: row.sourceHash,
    };
  }
  if (!replayed) {
    // The window stays as stated: a withdrawal says the publisher stopped
    // listing the version, not that its dates changed.
    // audit: skip — background corpus census; tombstones a public version the publisher no longer lists
    const written = await tx
      .update(legislationDocuments)
      .set({
        windowDisposition: "withdrawn",
        windowDispositionBasis: withdrawal.basis,
      })
      .where(
        and(
          eq(legislationDocuments.id, id),
          eq(
            legislationDocuments.payloadRevision,
            withdrawal.observedPayloadRevision,
          ),
          sql`${legislationDocuments.sourceHash} IS NOT DISTINCT FROM ${withdrawal.observedSourceHash}`,
        ),
      )
      .returning({ id: legislationDocuments.id });
    if (written.length !== 1) {
      return panic("locked legislation version refused its withdrawal", {
        id,
      });
    }
  }
  // Also on a replayed withdrawal: one recorded without its projection is
  // erased by the next.
  if (projectionLock !== null) {
    await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
      lock: projectionLock,
      subject,
    });
  }
  return { type: replayed ? "unchanged" : "withdrawn", id };
};

/**
 * Withdraw stored versions by the publisher's id, each under a
 * compare-and-set on what the census read. Idempotent: a replayed withdrawal
 * is `unchanged`, and a stale one writes nothing. One short transaction per
 * version, so one version's outcome never depends on another's.
 */
export const withdrawLegislationVersions = async (
  withdrawals: readonly LegislationWithdrawal[],
  scopedDb: ScopedDb,
): Promise<LegislationWithdrawalOutcome[]> => {
  if (withdrawals.length > LEGISLATION_WITHDRAWAL_BATCH_LIMIT) {
    return panic("too many legislation withdrawals in one batch", {
      count: withdrawals.length,
      limit: LEGISLATION_WITHDRAWAL_BATCH_LIMIT,
    });
  }
  const outcomes: LegislationWithdrawalOutcome[] = [];
  for (const raw of withdrawals) {
    const withdrawal = {
      ...raw,
      eli: stripDangerousChars(raw.eli),
      publisherId: stripDangerousChars(raw.publisherId),
    };
    // Found before the transaction that locks it, so a version removed in
    // between is a `missing` outcome rather than a failed batch.
    // db-await-in-loop: one lookup per version, bounded by the batch limit
    const found = await scopedDb(
      async (tx) => await withdrawalTargetQuery(tx, withdrawal),
    );
    const target = found.at(0);
    if (target === undefined) {
      outcomes.push({ type: "missing" });
      continue;
    }
    // db-await-in-loop: one short transaction per version, bounded by the batch limit
    const outcome = await scopedDb(
      async (tx) => await withdrawTarget(tx, target.id, withdrawal),
    );
    outcomes.push(outcome);
  }
  return outcomes;
};
