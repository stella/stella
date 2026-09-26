import { Result, panic } from "better-result";
import { eq } from "drizzle-orm";

import { createCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisionIdentifiers, caseLawDecisions } from "@/api/db/schema";
import { lockCitationGraph } from "@/api/handlers/case-law/citation-resolution";
import {
  CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS,
  createCaseLawDecisionSlugCandidate,
} from "@/api/handlers/case-law/decisions/slug";
import { writeDecisionCitations } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import {
  announceDecisionIdentifiers,
  reconcileStableProjection,
  writeDecisionJudges,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-row-context";
import type { DecisionRowWrite } from "@/api/handlers/case-law/ingestion/pipeline/decision-row-context";
import {
  describeRowUpdateTx,
  finishRefreshedRowTx,
  lostRowWriteStatus,
  readDocumentlessPayloadStateTx,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-row-update";
import { DECISION_ROW_WRITE_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { DecisionRowWriteStatus } from "@/api/handlers/case-law/ingestion/pipeline/types";
import {
  detachSupplementsLeftOut,
  lockSupplementTarget,
  markSupplementsMerged,
  sameSupplementVersions,
  selectComposableSupplements,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import type { SafeId } from "@/api/lib/branded-types";
import type { ActiveCorpusProjectionSourceLock } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { lockActiveCorpusProjectionSourceByIdTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { markListingOnly } from "@/api/lib/legal-search/ingestion-normalization";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";

/** The row a decision nothing stored yet is inserted as. */
const insertedRowValues = (
  {
    sourceId,
    decisionId,
    result,
    persistedSourceDocumentId,
    persistedDecisionDate,
    observedAt,
    observationOrder,
    shape: { storesUnpublishedWithoutDocument },
    plan: {
      caseNumberType,
      incomingCitationKey,
      languageGroupKey,
      payloadColumns,
    },
    rawArtifact: { sourceRawS3Key, sourceRawContentType },
  }: DecisionRowWrite,
  slug: string,
) => ({
  id: decisionId,
  sourceId,
  caseNumber: result.caseNumber,
  caseNumberType,
  sourceDocumentId: persistedSourceDocumentId,
  sheetNumber: result.sheetNumber,
  citationKey: incomingCitationKey,
  slug,
  ecli: result.ecli,
  court: result.court,
  courtId: result.courtId ?? null,
  country: result.country,
  language: result.language,
  languageGroupKey,
  decisionDate: persistedDecisionDate,
  decisionType: result.decisionType,
  ...payloadColumns,
  sourceUrl: result.sourceUrl,
  documentUrl: result.documentUrl,
  metadata: storesUnpublishedWithoutDocument
    ? markListingOnly(result.metadata)
    : result.metadata,
  parserVersion: result.parserVersion ?? 0,
  sourceRaw: null,
  sourceRawS3Key,
  sourceRawContentType,
  sourceHash: result.rawHash,
  sourceObservedAt: observedAt,
  sourceObservationOrder: observationOrder,
  sourceObservationHash: result.rawHash,
});

/**
 * Finish an inserted row in the row write's transaction, after the row and
 * its identifiers are written: its judges, the identifiers it announces to
 * the citation graph, and its citations.
 */
const finishInsertedRowTx = async (
  tx: Transaction,
  write: DecisionRowWrite,
  insertedId: SafeId<"caseLawDecision">,
  projectionLock: ActiveCorpusProjectionSourceLock | null,
): Promise<DecisionRowWriteStatus> => {
  const {
    observedAt,
    plan: { citationRows, identifierRows },
  } = write;
  await writeDecisionJudges(tx, write, insertedId);

  await announceDecisionIdentifiers(tx, write, insertedId, identifierRows);

  if (citationRows.length > 0) {
    // Settled as they are written, in the transaction that writes them.
    // One indexed lookup per citation against the fetch and parse this
    // page already paid for; without it every new citation waits for the
    // standing walk to come round, and the citator trails the crawl.
    await lockCitationGraph(tx);
    await writeDecisionCitations(tx, {
      decisionId: insertedId,
      rows: citationRows,
      observedAt,
      stored: false,
    });
  }
  await reconcileStableProjection(tx, write, insertedId, projectionLock);
  return DECISION_ROW_WRITE_STATUS.APPLIED;
};

/**
 * Write the decision's row, its identifiers and citations in one transaction.
 * Every statement that writes the decision's own rows runs here; the phases
 * around them are read, planned and finished by the helpers it calls.
 */
const writeDecisionRow = async (
  scopedDb: ScopedDb,
  write: DecisionRowWrite,
  slug?: string,
): Promise<DecisionRowWriteStatus> =>
  await scopedDb(async (tx) => {
    const {
      sourceId,
      decisionId,
      existing,
      composition,
      composedSupplements,
      shape: { preservesExistingDetail },
      plan: { payloadColumns, storedPayloadUnchanged },
    } = write;
    // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
    const projectionLock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
      family: "case_law",
      sourceId,
    });
    if (composition !== null) {
      // A supplement stored or merged since the composition was read would
      // otherwise be left out of this write, and nothing would ask again.
      await lockSupplementTarget(tx, composition.key);
      const current = await selectComposableSupplements(tx, {
        key: composition.key,
        decisionId,
        judgment: composition.judgment,
      });
      if (!sameSupplementVersions(current, composedSupplements)) {
        return DECISION_ROW_WRITE_STATUS.SUPPLEMENTS_MOVED;
      }
    }
    if (existing) {
      const { replacedState, payloadNeedsGuard, set, where } =
        await describeRowUpdateTx(tx, write, existing);
      const updated = await tx
        .update(caseLawDecisions)
        .set(set)
        .where(where)
        .returning({ id: caseLawDecisions.id });

      if (updated.length > 0 && composition !== null) {
        const merged = {
          sourceId,
          decisionId: existing.id,
          supplements: composedSupplements,
        };
        await markSupplementsMerged(tx, merged);
        // The document this update wrote is the one the supplements left
        // out are no longer in.
        await detachSupplementsLeftOut(tx, merged);
      }

      if (updated.length === 0) {
        // A newer observation owns the row. Its durable mirror state
        // decides whether this page may advance: a pending winner still
        // needs the source page as its replay path.
        // When it is still this observation's to write, the miss was the
        // payload fence: another write replaced what the plan compared
        // against.
        return await lostRowWriteStatus(tx, write, existing.id, {
          payloadFenced: storedPayloadUnchanged,
        });
      }

      if (payloadNeedsGuard) {
        // The row is locked by the update above, so what this reads is
        // what the write below would see. A row that holds a document is
        // not overwritten by one that carries none; a row that already
        // holds this document-less payload is not rewritten with it.
        const payloadState = await readDocumentlessPayloadStateTx(
          tx,
          write,
          existing,
        );
        if (payloadState === undefined || payloadState.holdsDocument) {
          return await lostRowWriteStatus(tx, write, existing.id, {
            payloadFenced: false,
          });
        }
        if (payloadState.differs) {
          await tx
            .update(caseLawDecisions)
            .set({ ...payloadColumns, updatedAt: new Date() })
            .where(eq(caseLawDecisions.id, existing.id));
        }
      }

      if (!preservesExistingDetail) {
        await tx
          .delete(caseLawDecisionIdentifiers)
          .where(eq(caseLawDecisionIdentifiers.decisionId, existing.id));
        await tx.insert(caseLawDecisionIdentifiers).values(
          write.plan.identifierRows.map((identifier) => ({
            decisionId: existing.id,
            ...identifier,
          })),
        );
        await writeDecisionJudges(tx, write, existing.id);
      }

      return await finishRefreshedRowTx(
        tx,
        write,
        existing,
        replacedState,
        projectionLock,
      );
    }

    if (slug === undefined) {
      panic("Missing slug for a new case-law decision");
    }

    const [decisionRow] = await tx
      .insert(caseLawDecisions)
      .values(insertedRowValues(write, slug))
      .returning({ id: caseLawDecisions.id });

    if (!decisionRow) {
      panic("Failed to insert decision: no row returned");
    }
    if (composedSupplements.length > 0) {
      await markSupplementsMerged(tx, {
        sourceId,
        decisionId: decisionRow.id,
        supplements: composedSupplements,
      });
    }

    await tx.insert(caseLawDecisionIdentifiers).values(
      write.plan.identifierRows.map((identifier) => ({
        decisionId: decisionRow.id,
        ...identifier,
      })),
    );
    return await finishInsertedRowTx(tx, write, decisionRow.id, projectionLock);
  });

/**
 * Write the decision's row, allocating a new decision's slug: the base slug
 * first, then a candidate per attempt while the slug index turns it away.
 *
 * Pass the original error through: the pipeline's halt semantics inspect
 * its type (a TimeoutError holds the cursor), which a wrapper would hide.
 */
export const writeDecisionRowWithSlug = async (
  scopedDb: ScopedDb,
  write: DecisionRowWrite,
): Promise<Result<DecisionRowWriteStatus, unknown>> => {
  const { sourceId, existing, persistedSourceDocumentId, result } = write;
  const slugIdentity = persistedSourceDocumentId
    ? `${sourceId}\u0000document\u0000${persistedSourceDocumentId}`
    : `${sourceId}\u0000case\u0000${result.caseNumber}\u0000${result.language}`;
  const baseSlug = createCaseLawDecisionSlug(result.caseNumber);
  const writeRow = async (slug?: string): Promise<DecisionRowWriteStatus> =>
    await writeDecisionRow(scopedDb, write, slug);

  let rowWrite = await Result.tryPromise({
    try: async () => await writeRow(existing ? undefined : baseSlug),
    catch: (cause: unknown) => cause,
  });

  for (const attempt of CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS) {
    if (attempt === 0) {
      continue;
    }
    if (Result.isOk(rowWrite)) {
      break;
    }
    if (
      !isPgConstraintError(
        rowWrite.error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_slug_uidx",
      )
    ) {
      break;
    }
    const slug = createCaseLawDecisionSlugCandidate({
      baseSlug,
      identity: slugIdentity,
      attempt,
    });
    rowWrite = await Result.tryPromise({
      // db-await-in-loop: slug-collision retry: the next candidate slug depends on this write's unique-violation outcome; attempts are capped
      try: async () => await writeRow(slug),
      catch: (cause: unknown) => cause,
    });
  }
  return rowWrite;
};

/** Whether a row write lost a race to insert the same publisher identity. */
export const isConcurrentIdentityInsert = (error: unknown): boolean =>
  isPgConstraintError(
    error,
    PG_ERROR.UNIQUE_VIOLATION,
    "case_law_decisions_source_document_idx",
  ) ||
  isPgConstraintError(
    error,
    PG_ERROR.UNIQUE_VIOLATION,
    "case_law_decisions_source_case_lang_null_idx",
  ) ||
  isPgConstraintError(
    error,
    PG_ERROR.UNIQUE_VIOLATION,
    "case_law_decisions_pkey",
  );
