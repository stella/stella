import { panic } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import type { LEGISLATION_WINDOW_DISPOSITION_BASES } from "@stll/api-contract/legislation-expression";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import { declareWriterContract } from "@/api/handlers/legislation/ingestion";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockActiveCorpusProjectionSourceTx,
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
export type LegislationWithdrawalBasis =
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
   * The row's `payload_revision` when the census decided. The withdrawal
   * applies only while the row still carries it, so a census that read the
   * row before a newer observation cannot tombstone that observation.
   */
  observedPayloadRevision: bigint;
};

export type LegislationWithdrawalOutcome =
  /** Withdrawn now; its search projection is erased with it. */
  | { type: "withdrawn"; id: SafeId<"legislationDocument"> }
  /** Already withdrawn on this basis: a replayed withdrawal. */
  | { type: "unchanged"; id: SafeId<"legislationDocument"> }
  /** The row changed after the census read it; nothing was written. */
  | {
      type: "stale";
      id: SafeId<"legislationDocument">;
      payloadRevision: bigint;
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
 * Withdraw one version, and bring its desired search projection to the
 * erase in the same transaction: nothing later re-derives it, so a
 * withdrawal committed without it would stay searchable.
 */
const withdrawOne = async (
  tx: Transaction,
  raw: LegislationWithdrawal,
): Promise<LegislationWithdrawalOutcome> => {
  const withdrawal = {
    ...raw,
    eli: stripDangerousChars(raw.eli),
    publisherId: stripDangerousChars(raw.publisherId),
  };
  await declareWriterContract(tx);
  const target = (await withdrawalTargetQuery(tx, withdrawal)).at(0);
  if (target === undefined) {
    return { type: "missing" };
  }
  const subject = { family: "legislation", entityId: target.id } as const;
  // The source before the row, in the order every legislation writer takes
  // them.
  const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, subject);
  const row = (
    await tx
      .select({
        payloadRevision: legislationDocuments.payloadRevision,
        windowDisposition: legislationDocuments.windowDisposition,
        windowDispositionBasis: legislationDocuments.windowDispositionBasis,
      })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, target.id))
      .for("update")
  ).at(0);
  if (row === undefined) {
    return panic("locked legislation version disappeared", { id: target.id });
  }
  const replayed =
    row.windowDisposition === "withdrawn" &&
    row.windowDispositionBasis === withdrawal.basis;
  if (!replayed && row.payloadRevision !== withdrawal.observedPayloadRevision) {
    return {
      type: "stale",
      id: target.id,
      payloadRevision: row.payloadRevision,
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
          eq(legislationDocuments.id, target.id),
          eq(
            legislationDocuments.payloadRevision,
            withdrawal.observedPayloadRevision,
          ),
        ),
      )
      .returning({ id: legislationDocuments.id });
    if (written.length !== 1) {
      return panic("locked legislation version refused its withdrawal", {
        id: target.id,
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
  return { type: replayed ? "unchanged" : "withdrawn", id: target.id };
};

/**
 * Withdraw stored versions by the publisher's id, each under a
 * compare-and-set on the payload revision the census observed. Idempotent: a
 * replayed withdrawal is `unchanged`, and a stale one writes nothing. One
 * short transaction per version, so one version's failure leaves the others'
 * outcomes durable.
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
  for (const withdrawal of withdrawals) {
    // db-await-in-loop: one short transaction per version, bounded by the batch limit
    outcomes.push(
      await scopedDb(async (tx) => await withdrawOne(tx, withdrawal)),
    );
  }
  return outcomes;
};
