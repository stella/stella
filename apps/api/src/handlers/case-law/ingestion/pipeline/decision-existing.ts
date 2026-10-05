import { and, eq, isNull, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import type { ExistingDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { storedObservationPrecedes } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import {
  DECISION_REFRESH,
  RECONCILE_CONTENTION,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import type {
  AttemptStep,
  DecisionRefresh,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import { unreadOutcomeOf } from "@/api/handlers/case-law/ingestion/pipeline/unread-items";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import type { PlainTextMetadataValue } from "@/api/lib/case-law/plain-text";
import {
  corpusCarriesDocument,
  payloadCarriesDocument,
} from "@/api/lib/case-law/stored-payload";
import { READ_OUTCOME_METADATA_KEY } from "@/api/lib/errors/read-outcome";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { parsePrimaryReferenceType } from "@/api/lib/legal-search/decision-primary-reference";
import { partialObservationFromMetadata } from "@/api/lib/legal-search/ingestion-normalization";
import { DOCUMENT_DELIVERY } from "@/api/lib/legal-search/ingestion-types";
import {
  OBSERVATION_DETAIL,
  OBSERVATION_DETAIL_RANK,
  observationDetailOf,
} from "@/api/lib/legal-search/partial-observation-sql";

/** What an observation carries, measured against the row it would write. */
export type ObservationShape = {
  storedPartialObservation: ReturnType<typeof partialObservationFromMetadata>;
  incomingCarriesDocument: boolean;
  /**
   * An inline observation fetched what the publisher serves, so one with no
   * document is a decision a reader cannot open. It is stored unpublished,
   * under the marker a listing-only row carries, and the same repair re-asks
   * the publisher for it. The marker is only ever set by a write that also
   * proves the row holds no document; a deferred source's text arrives by a
   * queue that never passes here, so its rows are left public.
   */
  storesUnpublishedWithoutDocument: boolean;
  /** A partial observation of a row that was enriched from detail before. */
  preservesExistingDetail: boolean;
  /**
   * An observation that carries more detail than the stored row, such as a
   * complete one of a listing-only row. It is always written: a source
   * fingerprint that leaves the detail out cannot tell the two apart.
   */
  upgradesStoredDetail: boolean;
};

type ClassifyObservationOptions = {
  result: IngestionResult;
  existing: ExistingDecision | undefined;
};

export const classifyObservation = ({
  result,
  existing,
}: ClassifyObservationOptions): ObservationShape => {
  const storedPartialObservation = existing
    ? partialObservationFromMetadata(existing.metadata)
    : partialObservationFromMetadata(undefined);
  const incomingCarriesDocument = payloadCarriesDocument({
    text: result.fulltext ?? null,
    sections: result.sections ?? null,
    ast: result.documentAst,
  });
  const storesUnpublishedWithoutDocument =
    !incomingCarriesDocument &&
    result.documentDelivery !== DOCUMENT_DELIVERY.DEFERRED;
  const incomingDetailRank =
    OBSERVATION_DETAIL_RANK[observationDetailOf(result)];
  const storedDetailRank =
    OBSERVATION_DETAIL_RANK[storedPartialObservation.detail];
  const preservesExistingDetail =
    existing !== undefined &&
    ((result.caseNumberIsPlaceholder === true &&
      !storedPartialObservation.caseNumberIsPlaceholder) ||
      incomingDetailRank < storedDetailRank);
  return {
    storedPartialObservation,
    incomingCarriesDocument,
    storesUnpublishedWithoutDocument,
    preservesExistingDetail,
    // An observation stored under the listing-only marker for want of a
    // document upgrades nothing.
    upgradesStoredDetail:
      existing !== undefined &&
      !storesUnpublishedWithoutDocument &&
      incomingDetailRank > storedDetailRank,
  };
};

/**
 * Bring the corpus projection of a settled row this observation did not
 * write up to the row, when a projection is active for it.
 */
const synchronizeSettledProjection = async (
  scopedDb: ScopedDb,
  existing: ExistingDecision,
): Promise<void> => {
  await scopedDb(async (tx) => {
    const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, {
      family: "case_law",
      entityId: existing.id,
    });
    if (projectionLock === null) {
      return;
    }
    const current = (
      await tx
        .select({
          corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, existing.id))
        .for("update")
        .limit(1)
    ).at(0);
    if (
      current === undefined ||
      current.redactedAt !== null ||
      current.corpusMirrorStatus !== CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED
    ) {
      return;
    }
    await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
      lock: projectionLock,
      subject: { family: "case_law", entityId: existing.id },
    });
  });
};

type WatermarkOptions = {
  scopedDb: ScopedDb;
  existing: ExistingDecision;
  result: IngestionResult;
  observedAt: Date;
  observationOrder: bigint;
};

/** Write an unread item's typed outcome under its metadata key. */
const recordReadOutcome = (outcome: PlainTextMetadataValue) =>
  sql`jsonb_set(coalesce(${caseLawDecisions.metadata}, '{}'::jsonb), ${`{${READ_OUTCOME_METADATA_KEY}}`}::text[], ${JSON.stringify(outcome)}::text::jsonb)`;

/**
 * The read-outcome marker an unchanged observation leaves on its row: an
 * unread item's outcome, or none once a read produced the item again.
 */
const unchangedReadOutcomeMetadata = (
  existing: ExistingDecision,
  result: IngestionResult,
) => {
  const unreadOutcome = unreadOutcomeOf(result);
  if (unreadOutcome !== undefined) {
    return { metadata: recordReadOutcome(unreadOutcome) };
  }
  if (existing.metadata?.[READ_OUTCOME_METADATA_KEY] === undefined) {
    return {};
  }
  return {
    metadata: sql`${caseLawDecisions.metadata} - ${READ_OUTCOME_METADATA_KEY}::text`,
  };
};

/**
 * Advance only the observation watermark of a row a partial observation
 * reached, while the row's corpus mirror is settled. An observation of an
 * unread item also records its typed outcome under one metadata key; the
 * row's detail, text and payload stay as stored.
 */
const advancePartialObservationWatermark = async ({
  scopedDb,
  existing,
  result,
  observedAt,
  observationOrder,
}: WatermarkOptions) =>
  await scopedDb(async (tx) => {
    const projectionActive = await lockActiveCorpusProjectionSourceTx(tx, {
      family: "case_law",
      entityId: existing.id,
    });
    const unreadOutcome = unreadOutcomeOf(result);
    // audit: skip — background case-law observation watermark; public data
    const advanced = (
      await tx
        .update(caseLawDecisions)
        .set({
          sourceObservedAt: observedAt,
          sourceObservationOrder: observationOrder,
          sourceObservationHash: result.rawHash,
          ...(unreadOutcome === undefined
            ? {}
            : {
                metadata: recordReadOutcome(unreadOutcome),
              }),
          updatedAt: sql`${caseLawDecisions.updatedAt}`,
        })
        .where(
          and(
            eq(caseLawDecisions.id, existing.id),
            storedObservationPrecedes({ order: observationOrder }),
            isNull(caseLawDecisions.redactedAt),
            eq(
              caseLawDecisions.corpusMirrorStatus,
              CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
            ),
          ),
        )
        .returning({ id: caseLawDecisions.id })
    ).at(0);
    if (advanced !== undefined && projectionActive !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: projectionActive,
        subject: { family: "case_law", entityId: existing.id },
      });
    }
    return advanced;
  });

/**
 * Advance only the observation watermark of a row an unchanged observation
 * reached, while the row still holds the source hash and metadata the
 * refresh check compared. The row's read-outcome marker follows this
 * observation.
 */
const advanceUnchangedObservationWatermark = async ({
  scopedDb,
  existing,
  result,
  observedAt,
  observationOrder,
}: WatermarkOptions) =>
  await scopedDb(async (tx) => {
    const projectionActive = await lockActiveCorpusProjectionSourceTx(tx, {
      family: "case_law",
      entityId: existing.id,
    });
    // audit: skip — background case-law ingestion ordering metadata; public case-law data, not user actions
    const advanced = (
      await tx
        .update(caseLawDecisions)
        .set({
          sourceObservedAt: observedAt,
          sourceObservationOrder: observationOrder,
          sourceObservationHash: result.rawHash,
          ...unchangedReadOutcomeMetadata(existing, result),
          // Drizzle applies the schema's on-update value unless this column is
          // explicit. A watermark-only replay is not a content modification.
          updatedAt: sql`${caseLawDecisions.updatedAt}`,
        })
        .where(
          and(
            eq(caseLawDecisions.id, existing.id),
            storedObservationPrecedes({ order: observationOrder }),
            isNull(caseLawDecisions.redactedAt),
            sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${existing.sourceHash}`,
            // The reference the skip compared, so a concurrent correction of
            // it is not overwritten by a watermark that says nothing changed.
            eq(caseLawDecisions.caseNumber, existing.caseNumber),
            eq(caseLawDecisions.caseNumberType, existing.caseNumberType),
            // `::text::jsonb`, never a bare `::jsonb`: the cast fixes the
            // bind parameter's type, and the driver then JSON-encodes the
            // already-serialized string, so the comparison sees a jsonb
            // *string* rather than the object and never matches.
            sql`${caseLawDecisions.metadata} IS NOT DISTINCT FROM ${JSON.stringify(existing.metadata)}::text::jsonb`,
          ),
        )
        .returning({ id: caseLawDecisions.id })
    ).at(0);
    if (advanced !== undefined && projectionActive !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: projectionActive,
        subject: { family: "case_law", entityId: existing.id },
      });
    }
    return advanced;
  });

type WatermarkMissOptions = {
  scopedDb: ScopedDb;
  existing: ExistingDecision;
  observationOrder: bigint;
};

/**
 * What a watermark update that matched no row means: the row was erased, its
 * mirror is pending, a newer observation owns it, or a concurrent write moved
 * it under this one.
 */
const watermarkMissOutcome = async ({
  scopedDb,
  existing,
  observationOrder,
}: WatermarkMissOptions): Promise<AttemptStep> => {
  const current = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: existing.id } },
      columns: {
        corpusMirrorStatus: true,
        sourceObservationOrder: true,
        redactedAt: true,
      },
    }),
  );
  if (current?.redactedAt) {
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      inserted: false,
      searchVectorFailed: false,
    };
  }
  if (current?.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.PENDING) {
    return {
      status: PROCESS_DECISION_STATUS.RETRYABLE,
      inserted: false,
      reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
    };
  }
  if (
    !current ||
    (current.sourceObservationOrder !== null &&
      current.sourceObservationOrder >= observationOrder)
  ) {
    if (current !== undefined) {
      await synchronizeSettledProjection(scopedDb, existing);
    }
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      inserted: false,
      searchVectorFailed: false,
    };
  }
  return RECONCILE_CONTENTION;
};

type ResolveExistingDecisionPolicyOptions = {
  scopedDb: ScopedDb;
  existing: ExistingDecision | undefined;
  result: IngestionResult;
  shape: ObservationShape;
  observedAt: Date;
  observationOrder: bigint;
  refresh: DecisionRefresh;
};

/**
 * Settle an observation that has nothing to write beyond its watermark: a
 * partial observation of a row enriched from detail, or an unchanged one.
 * Null when the observation goes on to write the row.
 */
export const resolveExistingDecisionPolicy = async ({
  scopedDb,
  existing,
  result,
  shape: {
    incomingCarriesDocument,
    preservesExistingDetail,
    storedPartialObservation,
    storesUnpublishedWithoutDocument,
    upgradesStoredDetail,
  },
  observedAt,
  observationOrder,
  refresh,
}: ResolveExistingDecisionPolicyOptions): Promise<AttemptStep | null> => {
  if (
    preservesExistingDetail &&
    existing !== undefined &&
    existing.corpusMirrorStatus !== CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
  ) {
    // A listing-only result carries less information than an identified row
    // that was previously enriched from detail. Advance only the source
    // observation watermark: replacing metadata, dates, raw-source pointers
    // or payload fields would make a temporary publisher regression durable.
    // A pending corpus mirror deliberately continues below: it must replay
    // the stored payload before this source page is allowed to advance.
    const watermarkAdvanced = await advancePartialObservationWatermark({
      scopedDb,
      existing,
      result,
      observedAt,
      observationOrder,
    });
    if (!watermarkAdvanced) {
      return await watermarkMissOutcome({
        scopedDb,
        existing,
        observationOrder,
      });
    }
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      inserted: false,
      searchVectorFailed: false,
    };
  }

  if (
    existing &&
    existing.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED &&
    refresh === DECISION_REFRESH.WHEN_SOURCE_CHANGED &&
    // A matching publisher hash cannot settle a row this observation
    // completes: the hash may leave out the detail that completes it.
    !upgradesStoredDetail &&
    // A matching publisher hash cannot settle a row whose stored document
    // is gone when this observation can restore it.
    !(incomingCarriesDocument && !existing.hasStoredDocument) &&
    // A row stored with no document before the marker existed is still
    // public. The unchanged observation that would be skipped is the one
    // that can mark it, so it is written instead.
    !(
      storesUnpublishedWithoutDocument &&
      storedPartialObservation.detail !== OBSERVATION_DETAIL.LISTING_ONLY &&
      !corpusCarriesDocument(existing.contentHash)
    ) &&
    existing.caseNumber === result.caseNumber &&
    existing.caseNumberType ===
      parsePrimaryReferenceType(result.caseNumberType) &&
    shouldSkipRefresh({
      existingMetadata: existing.metadata,
      existingSourceRawContentType: existing.sourceRawContentType,
      existingSourceHash: existing.sourceHash,
      incomingMetadata: result.metadata,
      incomingRawHash: result.rawHash,
      incomingSourceRawContentType: result.sourceRawContentType ?? "text/plain",
      incomingUsesSourceRawBytes: result.sourceRawBytes !== undefined,
    })
  ) {
    const watermarkAdvanced = await advanceUnchangedObservationWatermark({
      scopedDb,
      existing,
      result,
      observedAt,
      observationOrder,
    });
    if (!watermarkAdvanced) {
      return await watermarkMissOutcome({
        scopedDb,
        existing,
        observationOrder,
      });
    }
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      inserted: false,
      searchVectorFailed: false,
    };
  }

  return null;
};
