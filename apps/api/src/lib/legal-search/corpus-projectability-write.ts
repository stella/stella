import { panic } from "better-result";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { runDecisionWriteExtension } from "@/api/lib/case-law/decision-write-extension";
import {
  type TimestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import {
  type ActiveCorpusProjectionSourceLock,
  CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE,
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCaseLawProjectionBatchTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";

/**
 * The writes of the columns `corpus-projectability.ts` reads, each projected into every active
 * generation in the transaction that writes it.
 *
 * `corpus_mirror_status` and `content_hash` decide whether a row is
 * projectable and, for a decision, what it projects, so a write of either
 * that does not project in its own transaction leaves the row's desired
 * states stale, or a settled row with no state anywhere while its routes read
 * seeded. The `case-law-projectability-write` and
 * `legislation-projectability-write` ownership rows confine every write of
 * them to this module, or to an allowed writer that projects in the same
 * transaction.
 *
 * Lock order is the desired writers' order: the source share lock first,
 * then the canonical rows the update locks.
 */
/** The corpus storage columns a projection reads, written together or alone. */
type ProjectedCorpusColumns = Partial<{
  textS3Key: string;
  normalizedS3Key: string;
  astS3Key: string;
  contentHash: string;
}>;

type WriteProjectedCorpusColumnsInput =
  | {
      family: "case_law";
      id: SafeId<"caseLawDecision">;
      columns: ProjectedCorpusColumns;
      /** The caller's compare-and-set predicate on the row. */
      where: SQL | undefined;
    }
  | {
      family: "legislation";
      id: SafeId<"legislationDocument">;
      columns: ProjectedCorpusColumns;
      where: SQL | undefined;
    };

/** The source lock of one canonical row, or null when the row is gone. */
const lockRowSourceTx = async (
  tx: Transaction,
  input: WriteProjectedCorpusColumnsInput,
): Promise<{ lock: ActiveCorpusProjectionSourceLock | null } | null> => {
  if (input.family === "case_law") {
    const row = (
      await tx
        .select({ sourceId: caseLawDecisions.sourceId })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, input.id))
        .limit(1)
    ).at(0);
    return row === undefined
      ? null
      : {
          lock: await lockActiveCorpusProjectionSourceByIdTx(tx, {
            family: "case_law",
            sourceId: row.sourceId,
          }),
        };
  }
  const row = (
    await tx
      .select({ sourceId: legislationDocuments.sourceId })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, input.id))
      .limit(1)
  ).at(0);
  return row === undefined
    ? null
    : {
        lock: await lockActiveCorpusProjectionSourceByIdTx(tx, {
          family: "legislation",
          sourceId: row.sourceId,
        }),
      };
};

/**
 * Write a row's corpus object pointers or content hash under the caller's
 * compare-and-set, and project the row in the same transaction. Returns
 * whether the compare-and-set held.
 */
export const writeProjectedCorpusColumnsTx = async (
  tx: Transaction,
  input: WriteProjectedCorpusColumnsInput,
): Promise<boolean> => {
  const source = await lockRowSourceTx(tx, input);
  if (source === null) {
    return false;
  }
  // audit: skip - derived public corpus storage bookkeeping
  const recorded =
    input.family === "case_law"
      ? await tx
          .update(caseLawDecisions)
          .set({
            textS3Key: input.columns.textS3Key,
            normalizedS3Key: input.columns.normalizedS3Key,
            astS3Key: input.columns.astS3Key,
            contentHash: input.columns.contentHash,
          })
          .where(and(eq(caseLawDecisions.id, input.id), input.where))
          .returning({ id: caseLawDecisions.id })
      : await tx
          .update(legislationDocuments)
          .set({
            textS3Key: input.columns.textS3Key,
            normalizedS3Key: input.columns.normalizedS3Key,
            astS3Key: input.columns.astS3Key,
            contentHash: input.columns.contentHash,
          })
          .where(and(eq(legislationDocuments.id, input.id), input.where))
          .returning({ id: legislationDocuments.id });
  if (recorded.length === 0) {
    return false;
  }
  if (input.family === "case_law") {
    // The content hash and pointers are inputs of a decision's derived state.
    await runDecisionWriteExtension(tx, input.id);
  }
  if (source.lock !== null) {
    await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
      lock: source.lock,
      subject:
        input.family === "case_law"
          ? { family: "case_law", entityId: input.id }
          : { family: "legislation", entityId: input.id },
    });
  }
  return true;
};

/**
 * Share-lock the sources of these decisions before the caller locks the
 * decision rows, so a later projectability write in the same transaction
 * keeps the desired writers' lock order. Null when no case-law generation
 * is active.
 */
export const lockCaseLawProjectabilitySourcesTx = async (
  tx: Transaction,
  decisionIds: readonly SafeId<"caseLawDecision">[],
): Promise<ActiveCorpusProjectionSourceLock | null> => {
  if (decisionIds.length === 0) {
    return null;
  }
  const sources = await tx
    .selectDistinct({ sourceId: caseLawDecisions.sourceId })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...decisionIds]))
    .orderBy(caseLawDecisions.sourceId)
    .limit(decisionIds.length);
  return await lockCaseLawSourcesInOrderTx(
    tx,
    sources.map(({ sourceId }) => sourceId),
  );
};

/** Share-lock each source in id order; the lock proof is per family. */
const lockCaseLawSourcesInOrderTx = async (
  tx: Transaction,
  sourceIds: readonly SafeId<"caseLawSource">[],
  offset = 0,
  lock: ActiveCorpusProjectionSourceLock | null = null,
): Promise<ActiveCorpusProjectionSourceLock | null> => {
  const sourceId = sourceIds.at(offset);
  if (sourceId === undefined) {
    return lock;
  }
  const next = await lockActiveCorpusProjectionSourceByIdTx(tx, {
    family: "case_law",
    sourceId,
  });
  return await lockCaseLawSourcesInOrderTx(tx, sourceIds, offset + 1, next);
};

type CaseLawProjectionBatch = {
  sourceId: SafeId<"caseLawSource">;
  decisionIds: SafeId<"caseLawDecision">[];
};

/** One set-based reconciliation per source batch, in source order. */
const synchronizeCaseLawBatchesTx = async (
  tx: Transaction,
  lock: ActiveCorpusProjectionSourceLock,
  batches: readonly CaseLawProjectionBatch[],
  offset = 0,
): Promise<void> => {
  const batch = batches.at(offset);
  if (batch === undefined) {
    return;
  }
  await synchronizeLockedCaseLawProjectionBatchTx(tx, { lock, ...batch });
  await synchronizeCaseLawBatchesTx(tx, lock, batches, offset + 1);
};

/**
 * Project decisions whose projectability or projected hash the caller wrote
 * in this transaction, under the lock `lockCaseLawProjectabilitySourcesTx`
 * took before the rows. Set-based per source batch, so a page costs a fixed
 * number of statements per batch rather than several per decision.
 */
export const projectCaseLawDecisionsTx = async (
  tx: Transaction,
  lock: ActiveCorpusProjectionSourceLock,
  ids: readonly SafeId<"caseLawDecision">[],
): Promise<void> => {
  const requested = new Set(ids);
  if (requested.size === 0) {
    return;
  }
  const rows = await tx
    .select({ id: caseLawDecisions.id, sourceId: caseLawDecisions.sourceId })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...requested]))
    .orderBy(asc(caseLawDecisions.sourceId), asc(caseLawDecisions.id))
    .limit(requested.size);
  if (rows.length !== requested.size) {
    panic("Projected case-law decision disappeared");
  }
  const batches: CaseLawProjectionBatch[] = [];
  for (const { id, sourceId } of rows) {
    const batch = batches.at(-1);
    if (
      batch?.sourceId === sourceId &&
      batch.decisionIds.length < CASE_LAW_PROJECTION_REPAIR_BATCH_SIZE
    ) {
      batch.decisionIds.push(id);
    } else {
      batches.push({ sourceId, decisionIds: [id] });
    }
  }
  await synchronizeCaseLawBatchesTx(tx, lock, batches);
};

/** What a corpus write stored for a row: its object keys and content hash. */
type StoredCorpusWrite = {
  textKey: string;
  sectionsKey: string;
  astKey: string;
  contentHash: string;
};

/**
 * Record a legislation document's first corpus write: its object keys and
 * content hash, only while the document still has no recorded write and is
 * as the caller read it (`updatedAtToken`), so a concurrent ingestion refresh
 * that wrote newer keys is never pointed back at a stale payload. Projects
 * the document in the same transaction. Returns whether the compare-and-set
 * held. (A decision's first write settles through its upload intent instead,
 * `scripts/backfill-corpus-storage.ts`.)
 */
export const recordFirstLegislationCorpusWriteTx = async (
  tx: Transaction,
  input: {
    id: SafeId<"legislationDocument">;
    written: StoredCorpusWrite;
    updatedAtToken: TimestampCasToken;
  },
): Promise<boolean> =>
  await writeProjectedCorpusColumnsTx(tx, {
    family: "legislation",
    id: input.id,
    columns: {
      textS3Key: input.written.textKey,
      normalizedS3Key: input.written.sectionsKey,
      astS3Key: input.written.astKey,
      contentHash: input.written.contentHash,
    },
    where: and(
      isNull(legislationDocuments.textS3Key),
      timestampMatchesCasToken(
        legislationDocuments.updatedAt,
        input.updatedAtToken,
      ),
    ),
  });
