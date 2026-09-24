import { Result, panic } from "better-result";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { createCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";
import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisionIdentifiers,
  caseLawDecisionSourceIdentities,
  caseLawDecisions,
} from "@/api/db/schema";
import { proceduralKeysFromMetadata } from "@/api/handlers/case-law/citation-kind";
import {
  lockCitationGraph,
  reopenCitationsForDecisionIdentifiers,
  reopenCitationsForKeys,
  reopenCitationsFrom,
  reopenCitationsResolvedTo,
} from "@/api/handlers/case-law/citation-resolution";
import {
  CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS,
  createCaseLawDecisionSlugCandidate,
} from "@/api/handlers/case-law/decisions/slug";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  bareCitationKey,
  citationKeyOf,
  decisionIdentifiersFromMetadata,
  extractCitations,
  isSelfCitation,
  normalizeDecisionIdentifier,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { publisherCitationGap } from "@/api/handlers/case-law/ingestion/citation-recall";
import {
  buildCitationRows,
  writeDecisionCitations,
} from "@/api/handlers/case-law/ingestion/pipeline/citations";
import {
  SUPPLEMENT_ABSORB_FAILED,
  absorbComposedSupplementRows,
} from "@/api/handlers/case-law/ingestion/pipeline/composed-supplements";
import {
  settleCaseLawCorpusMirrorTx,
  rowHoldsDocument,
  storedRowDiffers,
  payloadChangedSql,
  hasStoredDocument,
  loadPendingMirrorPayload,
  decisionSections,
  caseLawCanonicalPayload,
  planCorpusWrite,
} from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import type {
  CorpusWritePlan,
  CorpusWritePayload,
} from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import {
  CASE_LAW_CORPUS_DEPENDENCIES,
  CASE_LAW_JUDGE_DEPENDENCIES,
} from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import {
  wrappedErrorDetail,
  PROCESS_DECISION_STATUS,
  PROCESS_DECISION_RETRY_REASON,
  processResultForCorpusOutcome,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { ProcessResult } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { writeOwnedRawPayload } from "@/api/handlers/case-law/ingestion/pipeline/raw-payload";
import {
  observationStillOwns,
  storedObservationPrecedes,
} from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import {
  CONTENTION_RECONCILIATION,
  DECISION_ROW_WRITE_STATUS,
  MAX_SOURCE_IDENTITY_CANDIDATES,
  DECISION_DATE_OUT_OF_BOUNDS,
  MAX_LOGGED_DECISION_DATE_LENGTH,
  DECISION_REFRESH,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import type {
  DecisionRowWriteStatus,
  ProcessDecisionAttemptOptions,
  ProcessDecisionOptions,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import {
  composeDecisionWithSupplements,
  detachSupplementsLeftOut,
  lockSupplementTarget,
  markSupplementsMerged,
  planSupplementComposition,
  sameSupplementVersions,
  selectComposableSupplements,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import {
  corpusCarriesDocument,
  pgPayloadCarriesDocument,
} from "@/api/handlers/case-law/stored-payload";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { preserveStoredTextAfterParseFailure } from "@/api/lib/case-law/decision-text";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { settleReservedCaseLawCorpusUpload } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import {
  enqueueCaseLawRawSweepTx,
  rawSweepSettleAfter,
} from "@/api/lib/legal-search/case-law-raw-sweeps";
import {
  lockActiveCorpusProjectionSourceByIdTx,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import type { ActiveCorpusProjectionSourceLock } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { openCorpusPackBatch } from "@/api/lib/legal-search/corpus-pack-batch";
import {
  corpusMirrorColumns,
  corpusPayloadDisposition,
  planCorpusDocumentWrite,
  storedCorpusWrite,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";
import {
  markListingOnly,
  partialObservationFromMetadata,
  sanitizeResult,
} from "@/api/lib/legal-search/ingestion-normalization";
import { DOCUMENT_DELIVERY } from "@/api/lib/legal-search/ingestion-types";
import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";
import {
  AST_MARKUP_RESIDUE,
  storedDecisionSignal,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { openRawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import type { RawSourceWriteFailure } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";
import {
  isPgConstraintError,
  PG_ERROR,
  pgErrorFields,
} from "@/api/lib/pg-error";

/** An ECLI's lookup spelling, or undefined when nothing searchable remains. */
const ecliComparisonKey = (ecli: string): string | undefined =>
  normalizeDecisionIdentifier({
    type: DECISION_IDENTIFIER_TYPES.ECLI,
    value: ecli,
  }) || undefined;

type CaseLawDecisionIdentityOptions = Pick<
  IngestionResult,
  "caseNumber" | "language" | "sourceDocumentId"
> & { sourceId: SafeId<"caseLawSource"> };

const NULL_SOURCE_DOCUMENT_ID_FILTER = { isNull: true } as const;

/** Match exactly the two partial unique indexes that define source identity. */
const caseLawDecisionIdentityWhere = ({
  caseNumber,
  language,
  sourceDocumentId,
  sourceId,
}: CaseLawDecisionIdentityOptions) =>
  sourceDocumentId
    ? { sourceId: { eq: sourceId }, sourceDocumentId }
    : {
        sourceId: { eq: sourceId },
        caseNumber,
        language,
        sourceDocumentId: NULL_SOURCE_DOCUMENT_ID_FILTER,
      };

/**
 * Insert a single decision and its citations into the database.
 * Skips duplicates based on sourceHash.
 */
const processDecisionAttempt = async ({
  input,
  judges,
  sourceId,
  scopedDb,
  observedAt,
  observationOrder,
  contentionReconciliation,
  refresh,
  corpus,
  corpusBatch,
  polarityRules,
}: ProcessDecisionAttemptOptions): Promise<ProcessResult> => {
  const observed = sanitizeResult(input);
  const rejectedDecisionDate =
    observed.decisionDate === undefined ? input.decisionDate : undefined;
  if (rejectedDecisionDate !== undefined) {
    logger.warn(DECISION_DATE_OUT_OF_BOUNDS, {
      sourceId,
      caseNumber: observed.caseNumber,
      decisionDate: rejectedDecisionDate.slice(
        0,
        MAX_LOGGED_DECISION_DATE_LENGTH,
      ),
    });
  }
  // The column needs all three states an observation can carry, and an
  // update omits an undefined field: a usable date is written, a stated but
  // unusable one clears the column rather than leaving in place the value it
  // was meant to replace, and an unstated one leaves the row as it is.
  const persistedDecisionDate =
    rejectedDecisionDate === undefined ? observed.decisionDate : null;
  const proposedDecisionId = createSafeId<"caseLawDecision">();
  const exactSourceIdentityCandidates = (() => {
    if (!observed.sourceDocumentId) {
      return [];
    }
    const identities = [observed.sourceDocumentId];
    if (observed.sourceDocumentIdAliases !== undefined) {
      identities.push(...observed.sourceDocumentIdAliases);
    }
    return [...new Set(identities)].toSorted();
  })();
  const repairSourceIdentityCandidates =
    observed.sourceDocumentId &&
    observed.sourceDocumentIdRepairAliases !== undefined
      ? [
          ...new Set(
            observed.sourceDocumentIdRepairAliases.filter(
              (identity) => !exactSourceIdentityCandidates.includes(identity),
            ),
          ),
        ].toSorted()
      : [];
  const sourceIdentityCandidates = [
    ...exactSourceIdentityCandidates,
    ...repairSourceIdentityCandidates,
  ].toSorted();
  if (sourceIdentityCandidates.length > MAX_SOURCE_IDENTITY_CANDIDATES) {
    panic("Too many publisher identities for one decision");
  }

  // Opened before the read below that proves the decision is not erased, so
  // every raw write this attempt makes starts within the window of that
  // read, and an erasure's settled sweep comes after all of them.
  const rawWriteWindow = openRawSourceWriteWindow();
  /** Set once this attempt starts writing raw objects under its decision. */
  let rawWriteAttempted = false;

  // Lock exact and repair-only identities before slow raw/corpus work. Exact
  // publisher aliases are reserved below. A heuristic repair alias may adopt
  // an existing owner, but is never claimed when absent: otherwise two normal
  // identified rows with the same degraded fingerprint could collapse.
  const identityResolution = await scopedDb(async (tx) => {
    for (const identity of sourceIdentityCandidates) {
      // SAFETY: candidates are hard-capped at eight above; sorted sequential
      // acquisition prevents deadlocks between overlapping identity sets.
      // eslint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded identity lock set must be sequential
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('case_law_source_identity'), hashtext(${`${sourceId}:${identity}`}))`,
      );
    }

    const claims =
      sourceIdentityCandidates.length === 0
        ? []
        : await tx.query.caseLawDecisionSourceIdentities.findMany({
            where: {
              sourceId: { eq: sourceId },
              sourceDocumentId: { in: sourceIdentityCandidates },
            },
            columns: { decisionId: true, sourceDocumentId: true },
            limit: MAX_SOURCE_IDENTITY_CANDIDATES,
          });
    const exactClaimedDecisionIds = [
      ...new Set(
        claims
          .filter(({ sourceDocumentId }) =>
            exactSourceIdentityCandidates.includes(sourceDocumentId),
          )
          .map(({ decisionId }) => decisionId),
      ),
    ];
    if (exactClaimedDecisionIds.length > 1) {
      panic("Publisher identities have conflicting decision owners");
    }
    let exactClaimedDecisionId = exactClaimedDecisionIds.at(0);
    const repairClaimedDecisionIds = [
      ...new Set(
        claims
          .filter(({ sourceDocumentId }) =>
            repairSourceIdentityCandidates.includes(sourceDocumentId),
          )
          .map(({ decisionId }) => decisionId),
      ),
    ];
    const repairClaimedDecisionId =
      repairClaimedDecisionIds.length === 1
        ? repairClaimedDecisionIds.at(0)
        : undefined;
    let provisionalClaimedDecisionId =
      exactClaimedDecisionId ?? repairClaimedDecisionId;
    const identityColumns = {
      id: true,
      // The three fields the candidate join filters on, read so a refresh can
      // tell whether it changes which citations may honestly point here.
      citationKey: true,
      country: true,
      decisionDate: true,
      sourceDocumentId: true,
      ecli: true,
      metadata: true,
      sourceHash: true,
      sourceObservedAt: true,
      sourceObservationHash: true,
      redactedAt: true,
      corpusMirrorStatus: true,
      // The write the row records for its canonical payload, so the corpus
      // upload can refuse re-PUTting objects a settled row already proved.
      contentHash: true,
      textS3Key: true,
      normalizedS3Key: true,
      astS3Key: true,
      sourceRawS3Key: true,
      sourceRawContentType: true,
      sourceUrl: true,
    } as const;
    const resolveExistingDecision = async () => {
      let provisionalIdentified = await tx.query.caseLawDecisions.findFirst({
        where:
          provisionalClaimedDecisionId === undefined
            ? caseLawDecisionIdentityWhere({
                caseNumber: observed.caseNumber,
                language: observed.language,
                sourceDocumentId: observed.sourceDocumentId,
                sourceId,
              })
            : { id: { eq: provisionalClaimedDecisionId } },
        columns: identityColumns,
      });
      if (
        exactClaimedDecisionId !== undefined &&
        provisionalIdentified === undefined
      ) {
        // A task from the previous rollout can insert the decision after a new
        // task reserved its identities but before that reservation produced a
        // row. Reconcile the durable reservation to the decision-table winner;
        // otherwise every replay targets the abandoned UUID and loses the same
        // publisher-identity uniqueness race forever.
        const rolloutWinners = await tx.query.caseLawDecisions.findMany({
          where: {
            sourceId: { eq: sourceId },
            sourceDocumentId: { in: exactSourceIdentityCandidates },
          },
          columns: identityColumns,
          limit: MAX_SOURCE_IDENTITY_CANDIDATES,
        });
        const rolloutWinnerIds = [
          ...new Set(rolloutWinners.map(({ id }) => id)),
        ];
        if (rolloutWinnerIds.length > 1) {
          panic("Publisher identities have conflicting decision rows");
        }
        const rolloutWinner = rolloutWinners.at(0);
        if (rolloutWinner !== undefined) {
          const abandonedDecisionId = exactClaimedDecisionId;
          // audit: skip — rolling-deployment identity convergence; public data
          await tx
            .update(caseLawDecisionSourceIdentities)
            .set({ decisionId: rolloutWinner.id })
            .where(
              and(
                eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
                eq(
                  caseLawDecisionSourceIdentities.decisionId,
                  abandonedDecisionId,
                ),
                inArray(
                  caseLawDecisionSourceIdentities.sourceDocumentId,
                  exactSourceIdentityCandidates,
                ),
              ),
            );
          exactClaimedDecisionId = rolloutWinner.id;
          provisionalClaimedDecisionId = rolloutWinner.id;
          provisionalIdentified = rolloutWinner;
        }
      }
      // A repair-only claim is consumable only while the decision is still
      // stored under that degraded identity. Once upgraded, the retained audit
      // mapping must not let an unrelated row reuse the heuristic fingerprint.
      const repairClaimIsCurrent =
        exactClaimedDecisionId !== undefined ||
        repairClaimedDecisionId === undefined ||
        (provisionalIdentified?.sourceDocumentId !== null &&
          provisionalIdentified?.sourceDocumentId !== undefined &&
          repairSourceIdentityCandidates.includes(
            provisionalIdentified.sourceDocumentId,
          ));
      const claimedDecisionId = repairClaimIsCurrent
        ? provisionalClaimedDecisionId
        : undefined;
      const exactIdentified =
        claimedDecisionId === provisionalClaimedDecisionId
          ? provisionalIdentified
          : await tx.query.caseLawDecisions.findFirst({
              where: caseLawDecisionIdentityWhere({
                caseNumber: observed.caseNumber,
                language: observed.language,
                sourceDocumentId: observed.sourceDocumentId,
                sourceId,
              }),
              columns: identityColumns,
            });
      const identified =
        exactIdentified ??
        (claimedDecisionId === undefined &&
        exactSourceIdentityCandidates.length > 1
          ? await tx.query.caseLawDecisions.findFirst({
              where: {
                sourceId: { eq: sourceId },
                sourceDocumentId: {
                  in: exactSourceIdentityCandidates.filter(
                    (identity) => identity !== observed.sourceDocumentId,
                  ),
                },
              },
              columns: identityColumns,
            })
          : undefined);

      // Adapters that learned the publisher's document id after their first
      // release may adopt a legacy null-id row, but only after proving which
      // publisher document produced it. A docket can publish siblings, so
      // encounter order is not identity.
      const legacy =
        identified ||
        !observed.sourceDocumentId ||
        claimedDecisionId !== undefined
          ? undefined
          : await tx.query.caseLawDecisions.findFirst({
              where: {
                sourceId: { eq: sourceId },
                caseNumber: observed.caseNumber,
                language: observed.language,
                sourceDocumentId: { isNull: true },
              },
              columns: identityColumns,
            });
      // ECLIs compare the way identifiers are looked up: an adapter release
      // may spell the same identifier with different case or separators.
      // The legacy candidate is already pinned to this exact docket.
      const legacyEcliKey =
        legacy?.ecli === null || legacy?.ecli === undefined
          ? undefined
          : ecliComparisonKey(legacy.ecli);
      const incomingEcliKeys = [observed.ecli, observed.legacyEcli].flatMap(
        (ecli) => {
          const key = ecli === undefined ? undefined : ecliComparisonKey(ecli);
          return key === undefined ? [] : [key];
        },
      );
      const ecliMatches =
        legacyEcliKey !== undefined && incomingEcliKeys.includes(legacyEcliKey);
      const legacyEcliContradicts =
        legacyEcliKey !== undefined &&
        incomingEcliKeys.length > 0 &&
        !ecliMatches;
      const sourceUrlMatches =
        legacy !== undefined &&
        !legacyEcliContradicts &&
        legacy.sourceUrl !== null &&
        observed.legacySourceUrls?.includes(legacy.sourceUrl) === true;
      const legacyMatches = ecliMatches || sourceUrlMatches;
      const existing = identified ?? (legacyMatches ? legacy : undefined);
      return {
        claimedDecisionId,
        existing,
      };
    };
    const { claimedDecisionId, existing } = await resolveExistingDecision();
    const decisionId = claimedDecisionId ?? existing?.id ?? proposedDecisionId;
    const existingIdentity = existing?.sourceDocumentId ?? undefined;
    const incomingSupersedesExisting =
      observed.sourceDocumentId !== undefined &&
      (existing?.sourceDocumentId === null ||
        existing?.sourceDocumentId === observed.sourceDocumentId ||
        (existingIdentity !== undefined &&
          (observed.sourceDocumentIdAliases?.includes(existingIdentity) ===
            true ||
            observed.sourceDocumentIdRepairAliases?.includes(
              existingIdentity,
            ) === true)));
    const persistedSourceDocumentId = incomingSupersedesExisting
      ? observed.sourceDocumentId
      : (existingIdentity ?? observed.sourceDocumentId);

    if (
      existing &&
      incomingSupersedesExisting &&
      existing.sourceDocumentId !== persistedSourceDocumentId
    ) {
      // Bind a newly learned canonical identity before any partial or
      // tombstone fast return. An inverse fallback observation never replaces
      // a previously bound canonical ID; the registry resolves it instead.
      // audit: skip — background identity repair for public case-law data
      await tx
        .update(caseLawDecisions)
        .set({
          sourceDocumentId: persistedSourceDocumentId,
          updatedAt: sql`${caseLawDecisions.updatedAt}`,
        })
        .where(eq(caseLawDecisions.id, existing.id));
    }

    if (exactSourceIdentityCandidates.length > 0) {
      // audit: skip — background publisher-identity ownership; public data
      await tx
        .insert(caseLawDecisionSourceIdentities)
        .values(
          exactSourceIdentityCandidates.map((sourceDocumentId) => ({
            sourceId,
            sourceDocumentId,
            decisionId,
          })),
        )
        .onConflictDoNothing();
    }

    // The supplements this judgment's document takes in: none for nearly
    // every decision, which the docket index answers without a row. Read in
    // this transaction rather than a later one of its own; the row write
    // checks it again under the docket lock.
    const composition = await planSupplementComposition(tx, {
      sourceId,
      decisionId,
      observation: observed,
    });

    return { existing, decisionId, persistedSourceDocumentId, composition };
  });
  const { existing, decisionId, persistedSourceDocumentId, composition } =
    identityResolution;

  if (existing?.redactedAt) {
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      inserted: false,
      searchVectorFailed: false,
    };
  }

  const composedSupplements =
    composition === null ? [] : composition.supplements;
  const result = composeDecisionWithSupplements(observed, composedSupplements);

  const synchronizeSettledProjection = async (): Promise<void> => {
    if (existing === undefined) {
      return;
    }
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

  const storedPartialObservation = existing
    ? partialObservationFromMetadata(existing.metadata)
    : { caseNumberIsPlaceholder: false, isListingOnly: false };
  const incomingCarriesDocument = Boolean(
    result.fulltext || hasUsableAst(result.documentAst),
  );
  // An inline observation fetched what the publisher serves, so one with no
  // document is a decision a reader cannot open. It is stored unpublished,
  // under the marker a listing-only row carries, and the same repair re-asks
  // the publisher for it. The marker is only ever set by a write that also
  // proves the row holds no document; a deferred source's text arrives by a
  // queue that never passes here, so its rows are left public.
  const storesUnpublishedWithoutDocument =
    !incomingCarriesDocument &&
    result.documentDelivery !== DOCUMENT_DELIVERY.DEFERRED;
  const preservesExistingDetail =
    existing !== undefined &&
    ((result.caseNumberIsPlaceholder === true &&
      !storedPartialObservation.caseNumberIsPlaceholder) ||
      (result.isListingOnly === true &&
        !storedPartialObservation.isListingOnly));

  const resolveExistingDecisionPolicy =
    async (): Promise<ProcessResult | null> => {
      if (
        preservesExistingDetail &&
        existing.corpusMirrorStatus !== CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
      ) {
        // A listing-only result carries less information than an identified row
        // that was previously enriched from detail. Advance only the source
        // observation watermark: replacing metadata, dates, raw-source pointers
        // or payload fields would make a temporary publisher regression durable.
        // A pending corpus mirror deliberately continues below: it must replay
        // the stored payload before this source page is allowed to advance.
        const watermarkAdvanced = await scopedDb(async (tx) => {
          const projectionActive = await lockActiveCorpusProjectionSourceTx(
            tx,
            { family: "case_law", entityId: existing.id },
          );
          // audit: skip — background case-law observation watermark; public data
          const advanced = (
            await tx
              .update(caseLawDecisions)
              .set({
                sourceObservedAt: observedAt,
                sourceObservationOrder: observationOrder,
                sourceObservationHash: result.rawHash,
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
        if (!watermarkAdvanced) {
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
          if (
            current?.corpusMirrorStatus ===
            CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
          ) {
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
              await synchronizeSettledProjection();
            }
            return {
              status: PROCESS_DECISION_STATUS.COMPLETE,
              inserted: false,
              searchVectorFailed: false,
            };
          }
          if (contentionReconciliation === CONTENTION_RECONCILIATION.RETRY) {
            return {
              status: PROCESS_DECISION_STATUS.RETRYABLE,
              inserted: false,
              reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
            };
          }
          return await processDecisionAttempt({
            input,
            sourceId,
            scopedDb,
            observedAt,
            observationOrder,
            contentionReconciliation: CONTENTION_RECONCILIATION.RETRY,
            refresh,
            corpus,
            corpusBatch,
            judges,
            polarityRules,
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
        // A row stored with no document before the marker existed is still
        // public. The unchanged observation that would be skipped is the one
        // that can mark it, so it is written instead.
        !(
          storesUnpublishedWithoutDocument &&
          !storedPartialObservation.isListingOnly &&
          !corpusCarriesDocument(existing.contentHash)
        ) &&
        shouldSkipRefresh({
          existingMetadata: existing.metadata,
          existingSourceRawContentType: existing.sourceRawContentType,
          existingSourceHash: existing.sourceHash,
          incomingMetadata: result.metadata,
          incomingRawHash: result.rawHash,
          incomingSourceRawContentType:
            result.sourceRawContentType ?? "text/plain",
          incomingUsesSourceRawBytes: result.sourceRawBytes !== undefined,
        })
      ) {
        const watermarkAdvanced = await scopedDb(async (tx) => {
          const projectionActive = await lockActiveCorpusProjectionSourceTx(
            tx,
            { family: "case_law", entityId: existing.id },
          );
          // audit: skip — background case-law ingestion ordering metadata; public case-law data, not user actions
          const advanced = (
            await tx
              .update(caseLawDecisions)
              .set({
                sourceObservedAt: observedAt,
                sourceObservationOrder: observationOrder,
                sourceObservationHash: result.rawHash,
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
        if (!watermarkAdvanced) {
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
          if (
            current?.corpusMirrorStatus ===
            CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
          ) {
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
              await synchronizeSettledProjection();
            }
            return {
              status: PROCESS_DECISION_STATUS.COMPLETE,
              inserted: false,
              searchVectorFailed: false,
            };
          }
          if (contentionReconciliation === CONTENTION_RECONCILIATION.RETRY) {
            return {
              status: PROCESS_DECISION_STATUS.RETRYABLE,
              inserted: false,
              reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
            };
          }
          return await processDecisionAttempt({
            input,
            sourceId,
            scopedDb,
            observedAt,
            observationOrder,
            contentionReconciliation: CONTENTION_RECONCILIATION.RETRY,
            refresh,
            corpus,
            corpusBatch,
            judges,
            polarityRules,
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
  const existingPolicyOutcome = await resolveExistingDecisionPolicy();
  if (existingPolicyOutcome !== null) {
    return existingPolicyOutcome;
  }

  /**
   * Raw objects this attempt wrote for a decision whose row it will not
   * insert. Whether anything may keep them depends on whether a row or a
   * reservation for the id ever lands, which the sweeper decides once every
   * write for it is over; a failure to record that is left to the census.
   */
  const recordAbandonedRawWrite = async (): Promise<void> => {
    if (existing !== undefined || !rawWriteAttempted) {
      return;
    }
    const recorded = await Result.tryPromise({
      try: async () =>
        await scopedDb(async (tx) => {
          await enqueueCaseLawRawSweepTx(tx, {
            decisionId,
            sourceId,
            firstAttemptAt: rawSweepSettleAfter(),
            settleAfter: rawSweepSettleAfter(),
          });
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(recorded)) {
      captureError(recorded.error, {
        decisionId,
        sourceId,
        step: "processDecision.recordAbandonedRawWrite",
      });
    }
  };

  // Acquire the raw-source artifact before persisting its hash. A new row
  // cannot safely advance without the artifact; an update preserves its old
  // key and carries a retryable failure through the eventual row outcome.
  const acquireSourceRawArtifact = async () => {
    const rawContentType = result.sourceRawContentType ?? "text/plain";
    const storedRawKey = existing?.sourceRawS3Key ?? null;
    const storedRawContentType = existing?.sourceRawContentType ?? null;

    const acquired = (artifact: {
      s3UploadFailed: boolean;
      sourceRawContentType: string | null;
      sourceRawS3Key: string | null;
    }) => ({ type: "acquired", artifact }) as const;

    if (preservesExistingDetail) {
      return acquired({
        s3UploadFailed: false,
        sourceRawS3Key: existing.sourceRawS3Key,
        sourceRawContentType: existing.sourceRawContentType,
      });
    }

    const rawWriteFailed = (error: unknown) => {
      if (!existing) {
        // New decision: hold the page's cursor and retry the slice.
        // Inserting with sourceRawS3Key: null would set sourceHash,
        // causing the dedup check to skip it permanently — the raw
        // source would be lost forever.
        //
        // Reported as retryable rather than thrown: the decision loop
        // catches a throw, counts it as skipped, and lets the cursor
        // advance, so a forward-only traversal passes the decision and
        // never returns to it. Only a retryable outcome reaches the
        // page-level hold.
        logger.error("case_law.ingestion.source_raw_write_failed", {
          sourceId,
          caseNumber: result.caseNumber,
          ...errorSystemFields(error),
          ...pgErrorFields(error),
          "error.detail": wrappedErrorDetail(error),
        });
        captureError(error, { sourceId, step: "uploadSourceRaw" });

        return {
          type: "retry",
          outcome: {
            status: PROCESS_DECISION_STATUS.RETRYABLE,
            inserted: false,
            reason: PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE,
          },
        } as const;
      }

      captureError(error, { sourceId, step: "uploadSourceRaw" });

      // Update: preserve existing S3 key and DO NOT advance sourceHash.
      // If we wrote the new hash with the old key, the hash mismatch
      // would never trigger again and the stale raw source could never
      // be corrected through normal ingestion.
      return acquired({
        s3UploadFailed: true,
        sourceRawS3Key: existing.sourceRawS3Key,
        sourceRawContentType: existing.sourceRawContentType,
      });
    };

    /**
     * Store the payload and the files it names, answering its key, or
     * undefined when this observation carries none. Every write is
     * content-addressed and created only if absent, so a retry after a
     * failure between them lands nothing twice.
     */
    const writeRaw = async (): Promise<
      Result<string | undefined, RawSourceWriteFailure>
    > =>
      await writeOwnedRawPayload({
        result,
        sourceId,
        ownerId: decisionId,
        contentType: rawContentType,
        storedKey: storedRawKey,
        storedContentType: storedRawContentType,
        window: rawWriteWindow,
        onWriteStart: () => {
          rawWriteAttempted = true;
        },
      });

    try {
      const written = await writeRaw();
      if (Result.isError(written)) {
        return rawWriteFailed(written.error);
      }
      return written.value === undefined
        ? acquired({
            s3UploadFailed: false,
            sourceRawS3Key: null,
            sourceRawContentType: null,
          })
        : acquired({
            s3UploadFailed: false,
            sourceRawS3Key: written.value,
            sourceRawContentType: rawContentType,
          });
    } catch (error) {
      return rawWriteFailed(error);
    }
  };
  const sourceRawArtifact = await acquireSourceRawArtifact();
  if (sourceRawArtifact.type === "retry") {
    await recordAbandonedRawWrite();
    return sourceRawArtifact.outcome;
  }
  const {
    sourceRawContentType,
    sourceRawS3Key,
    s3UploadFailed: rawUploadFailed,
  } = sourceRawArtifact.artifact;
  const s3UploadFailed = rawUploadFailed;

  /**
   * The raw-source retry the row carries, independent of the corpus write.
   *
   * An update whose raw upload failed kept its old `sourceHash` so the next
   * pass re-observes the decision; reporting it complete would strand that
   * retry. Every return that would otherwise report a decision this pass
   * wrote as complete goes through here, so the single-decision path and the
   * page-batch path answer the same way. A row that was redacted or removed
   * while the batch ran has nothing left to re-observe, and is reported as
   * complete with `inserted: false`, so it is left alone.
   */
  const withSourceRawRetry = (outcome: ProcessResult): ProcessResult =>
    s3UploadFailed &&
    outcome.status === PROCESS_DECISION_STATUS.COMPLETE &&
    outcome.inserted
      ? {
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          inserted: true,
          reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
        }
      : outcome;

  const preparePersistenceInputs = async () => {
    const sections = decisionSections(result);

    // A metadata-first source keeps refreshing a decision it has no
    // document for: the list endpoint's fields change, the hash moves, and
    // the adapter returns the same empty AST it returned at first sight.
    // Applying that over a decision whose document has since arrived — by
    // hydration or backfill — would put the empty AST back, and under
    // corpus storage would rewrite the objects empty and move the row's
    // keys onto them, which is precisely the state the repair pass exists
    // to undo. Nothing the refresh carries is a document, so nothing it
    // carries may replace one: the metadata is updated and the payload,
    // its object-storage pointers and the citations drawn from it are left
    // as they are.
    const preserveStoredDocument =
      existing !== undefined &&
      !incomingCarriesDocument &&
      (await hasStoredDocument(existing.id, scopedDb));
    const pendingMirrorPayload =
      existing?.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.PENDING &&
      !incomingCarriesDocument
        ? await loadPendingMirrorPayload(existing.id, scopedDb)
        : null;

    // Parsers report their own quality through `validateAndLog`, but a
    // source whose parser never runs reports nothing at all. Emit the
    // same signal here so every stored decision is accounted for, and
    // split the severity the same way: no text is an error, text without
    // structure is a warning. A refresh that preserves the stored document
    // reports nothing: it did not store an empty decision, it left a full
    // one alone, and these errors are what an operator sweeps for.
    const astBlocks = hasUsableAst(result.documentAst)
      ? result.documentAst.blocks.length
      : 0;
    const signal =
      preserveStoredDocument || pendingMirrorPayload !== null
        ? undefined
        : storedDecisionSignal({
            hasFulltext: Boolean(result.fulltext),
            astBlocks,
          });
    if (signal) {
      const subject = {
        sourceId,
        caseNumber: result.caseNumber,
        language: result.language,
        url: result.sourceUrl ?? result.documentUrl ?? "",
        fulltextLength: result.fulltext?.length ?? 0,
      };
      if (signal.level === "error") {
        logger.error(signal.event, subject);
      } else {
        logger.warn(signal.event, subject);
      }
    }

    // Same reasoning for markup that survived into the text: a parser
    // reports its own blocks through `validateAndLog`, so this covers the
    // decisions no parser produced — the source's payload stored verbatim
    // as the document. Skipped where a stored document is being preserved,
    // which stores no text of its own.
    const storedResidue =
      preserveStoredDocument ||
      pendingMirrorPayload !== null ||
      astBlocks > 0 ||
      !result.fulltext
        ? undefined
        : markupResidueIn(result.fulltext);
    if (storedResidue) {
      logger.error(AST_MARKUP_RESIDUE, {
        sourceId,
        caseNumber: result.caseNumber,
        language: result.language,
        url: result.sourceUrl ?? result.documentUrl ?? "",
        residueRule: storedResidue.rule,
        residueAnchorId: "fulltext",
        residueExcerpt: storedResidue.excerpt,
      });
    }

    // The publisher's own statement of the case's procedural history, where
    // it supplies one; classification consults it before any heuristic.
    const proceduralKeys = proceduralKeysFromMetadata(
      result.metadata,
      (caseNumber) => bareCitationKey(caseNumber),
    );

    const decisionIdentifiers = decisionIdentifiersFromMetadata({
      caseNumber: result.caseNumber,
      ecli: result.ecli ?? null,
      identifiers: result.identifiers,
    });
    const identifierRows = decisionIdentifiers.map((identifier) => ({
      type: identifier.type,
      value: identifier.value,
      normalizedValue: normalizeDecisionIdentifier(identifier),
    }));
    const citations = extractCitations(
      sections.map((s) => ({ index: s.index, text: s.text })),
    ).filter((c) => !isSelfCitation(c.citationText, decisionIdentifiers));

    // Where the publisher supplies its own cited-decisions list, it is the
    // one ground truth extraction can be measured against without measuring
    // it against itself. Computed here, emitted only after the row write
    // commits (a replayed decision must not re-count) — and emitted for
    // zero-gap decisions too, or aggregated events could not produce a
    // recall denominator.
    // Measured only when the incoming payload carries a document: an empty
    // payload has nothing for extraction to find, so every publisher
    // citation would read as missed — on document-preserving refreshes and
    // equally when a concurrent backfill wins the row between the read and
    // the transaction. Emitted here rather than after the write because an
    // ambiguous timeout can commit the row yet throw, and the replay
    // dedup-skips before re-measuring; the source hash is the identity a
    // consumer deduplicates retries on.
    if (
      incomingCarriesDocument &&
      !preserveStoredDocument &&
      result.publisherCitedCases &&
      result.publisherCitedCases.length > 0
    ) {
      const recall = publisherCitationGap({
        extracted: citations.map((c) => c.citationText),
        publisherCited: result.publisherCitedCases,
      });
      const level = recall.missed.length > 0 ? "warn" : "info";
      logger[level]("case_law.ingestion.citation_recall", {
        caseNumber: result.caseNumber,
        language: result.language,
        url: result.sourceUrl ?? "",
        sourceHash: result.rawHash,
        publisherCitedCount: recall.publisherCitedCount,
        missedCount: recall.missed.length,
        missed: recall.missed.slice(0, 10).join("; "),
      });
    }

    const languageGroupKey = result.ecli || `${sourceId}:${result.caseNumber}`;

    // Corpus objects and every publisher alias now share the UUID reserved by
    // identity resolution before any external write.

    const corpusPayload: CorpusWritePayload =
      pendingMirrorPayload === null
        ? {
            documentId: decisionId,
            jurisdiction: result.country,
            ...caseLawCanonicalPayload(result),
          }
        : {
            documentId: decisionId,
            jurisdiction: result.country,
            ...pendingMirrorPayload,
          };
    const mirrorCarriesDocument = Boolean(
      corpusPayload.text || hasUsableAst(corpusPayload.ast),
    );

    // A payload with no document has nothing to put in the corpus: its
    // mirror write stores nothing and settles the row with no pointers.
    // Writing that settled state directly is the same row, without taking it
    // through pending and back on every refresh of a document-less decision.
    const modePlan: CorpusWritePlan =
      mirrorCarriesDocument || pendingMirrorPayload !== null
        ? planCorpusWrite(corpus.mode)
        : { type: "postgres-only" };

    // The publisher's page can move while the document it carries does not.
    // A settled row that already records this exact payload in the corpus
    // keeps it: writing it back into the row as pending, only for the settle
    // to put the same pointers back, rewrites the whole document for nothing.
    // Asked of the corpus write's own planner, which compares the keys and
    // not the hash alone: a payload whose jurisdiction moved must still land
    // under its new partition. The write is fenced on the recorded hash, so
    // a payload replaced since the read is not taken for this one.
    const storedPayloadUnchanged =
      existing !== undefined &&
      modePlan.type !== "postgres-only" &&
      existing.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED &&
      corpusCarriesDocument(existing.contentHash) &&
      planCorpusDocumentWrite({
        ...corpusPayload,
        stored: storedCorpusWrite(existing),
      }).type === "skipped-unchanged";

    const corpusPlan: CorpusWritePlan =
      (preserveStoredDocument && pendingMirrorPayload === null) ||
      storedPayloadUnchanged
        ? { type: "preserve-stored" }
        : modePlan;

    // A pending mirror's payload was read out of the row, and the write that
    // replays it is fenced on the observation that stored it, so the row
    // already holds exactly this payload. Writing it back would copy the
    // whole document into a new row version to say the same thing.
    const postgresPayload =
      pendingMirrorPayload === null
        ? {
            fulltext: corpusPayload.text,
            sections: corpusPayload.sections,
            documentAst: corpusPayload.ast,
          }
        : {};

    const payloadColumns = (() => {
      switch (corpusPlan.type) {
        case "postgres-only":
          // This refresh supersedes whatever the corpus holds and nothing
          // will follow to rewrite the pointers, so a row carrying keys from
          // an earlier canonical/dual-write period would point at objects
          // that no longer match its columns. Clear them.
          return {
            ...postgresPayload,
            ...corpusMirrorColumns({
              status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
              written: null,
            }),
          };
        case "postgres-mirrored":
        case "object-storage":
          // Persist retry intent with the Postgres payload. Clearing every old
          // pointer makes the pending branch structurally unable to serve a
          // stale mirror while an unchanged replay repairs it.
          return {
            ...postgresPayload,
            ...corpusMirrorColumns({
              status: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
            }),
          };
        case "preserve-stored":
          // Every pointer into object storage stays exactly as stored.
          // Leaving the payload out of the update is what preserves it,
          // except where the corpus is confirmed to hold this exact payload
          // and the mode keeps it only there: those columns converge to
          // the trimmed shape the settle would have left.
          return storedPayloadUnchanged &&
            corpusPayloadDisposition({
              mode: corpus.mode,
              written: storedCorpusWrite(existing),
            }) === "trim"
            ? { ...TRIMMED_CORPUS_PAYLOAD_COLUMNS }
            : {};
        default: {
          corpusPlan satisfies never;
          return panic(`Unhandled corpus write plan: ${String(corpusPlan)}`);
        }
      }
    })();

    const incomingCitationKey = citationKeyOf(result.caseNumber);
    return {
      // Built here, outside the write transaction: classifying a citation
      // reads the polarity rules, and the write path must not hold a row
      // lock across that read. The citing row is either the one identity
      // resolution found or the one this attempt is about to insert under
      // the id it already reserved.
      citationRows: await buildCitationRows({
        citations,
        citingDecisionId: existing?.id ?? decisionId,
        language: result.language,
        polarityRules,
        proceduralKeys,
        scopedDb,
        sections,
      }),
      corpusPayload,
      corpusPlan,
      identifierRows,
      incomingCitationKey,
      languageGroupKey,
      mirrorCarriesDocument,
      payloadColumns,
      pendingMirrorPayload,
      storedPayloadUnchanged,
    };
  };
  const {
    citationRows,
    corpusPayload,
    corpusPlan,
    identifierRows,
    incomingCitationKey,
    languageGroupKey,
    mirrorCarriesDocument,
    payloadColumns,
    pendingMirrorPayload,
    storedPayloadUnchanged,
  } = await preparePersistenceInputs();

  /**
   * Tell the citation graph which normalized identifiers this decision holds.
   *
   * A stored decision changes the answer for citations that are not its own,
   * in both directions: it can satisfy citations that gave up on that key, and
   * it can make a key that had exactly one holder ambiguous, which retracts
   * edges drawn to the earlier holder. Neither is discoverable from the citing
   * side, so the standing walk would never revisit them; doing it here, in the
   * transaction that created the reason, is what keeps the graph honest.
   *
   * Only when the identifier set is genuinely new to this row: a metadata
   * refresh under the same identities changes nothing about who can be cited.
   */
  type DecisionIdentifierLookup = Pick<
    (typeof identifierRows)[number],
    "type" | "normalizedValue"
  >;
  const announceDecisionIdentifiers = async (
    tx: Transaction,
    id: SafeId<"caseLawDecision">,
    identifiers: readonly DecisionIdentifierLookup[],
  ): Promise<void> => {
    if (identifiers.length === 0) {
      return;
    }
    if (!isCaseLawJurisdiction(result.country)) {
      // A stored country nobody declares a resolution policy for. Loud rather
      // than defaulted: guessing a reach would write cross-border edges on an
      // assumption, and the fix is a declaration, not a fallback.
      logger.error("case_law.citation_resolution.undeclared_jurisdiction", {
        jurisdiction: result.country,
      });
      return;
    }
    await reopenCitationsForDecisionIdentifiers(tx, {
      identifiers,
      decisionId: id,
      jurisdiction: result.country,
      decisionDate: persistedDecisionDate ?? null,
    });
  };

  /** Decision state locked immediately before this transaction overwrites it. */
  const replacedDecisionState = async (
    tx: Transaction,
    id: SafeId<"caseLawDecision">,
  ): Promise<{
    citationKey: string | null;
    country: string;
    language: string;
    decisionDate: string | null;
    metadata: Record<string, unknown> | null;
    identifiers: {
      type: (typeof identifierRows)[number]["type"];
      normalizedValue: string;
      value: string;
    }[];
  } | null> => {
    const rows = await tx
      .select({
        citationKey: caseLawDecisions.citationKey,
        country: caseLawDecisions.country,
        language: caseLawDecisions.language,
        decisionDate: caseLawDecisions.decisionDate,
        metadata: caseLawDecisions.metadata,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, id))
      .for("update")
      .limit(1);
    const row = rows.at(0);
    if (!row) {
      return null;
    }
    const identifiers = await tx
      .select({
        type: caseLawDecisionIdentifiers.type,
        normalizedValue: caseLawDecisionIdentifiers.normalizedValue,
        value: caseLawDecisionIdentifiers.value,
      })
      .from(caseLawDecisionIdentifiers)
      .where(eq(caseLawDecisionIdentifiers.decisionId, id));
    return { ...row, identifiers };
  };

  const resolutionIdentityChanged = (previous: {
    citationKey: string | null;
    country: string;
    language: string;
    decisionDate: string | null;
    identifiers: {
      type: (typeof identifierRows)[number]["type"];
      normalizedValue: string;
    }[];
  }): boolean => {
    const incoming = new Set(
      identifierRows.map(
        (identifier) => `${identifier.type}:${identifier.normalizedValue}`,
      ),
    );
    const identifiersChanged =
      previous.identifiers.length !== incoming.size ||
      previous.identifiers.some(
        (identifier) =>
          !incoming.has(`${identifier.type}:${identifier.normalizedValue}`),
      );
    return (
      identifiersChanged ||
      previous.citationKey !== incomingCitationKey ||
      previous.country !== result.country ||
      // The citing language picks which manifestation of a multilingual
      // target an edge lands on, and this decision's own language is what
      // other citers' edges pick by.
      previous.language !== result.language ||
      (persistedDecisionDate !== undefined &&
        previous.decisionDate !== persistedDecisionDate)
    );
  };

  /**
   * Whether the identifier rows this write replaces differ from the ones it
   * writes, stated values included: the search document is built from them.
   */
  const identifiersRewritten = (
    previous: {
      identifiers: {
        type: string;
        normalizedValue: string;
        value: string;
      }[];
    } | null,
  ): boolean => {
    if (previous === null) {
      return false;
    }
    const key = (identifier: {
      type: string;
      normalizedValue: string;
      value: string;
    }) =>
      `${identifier.type}\u0000${identifier.normalizedValue}\u0000${identifier.value}`;
    const incoming = new Set(identifierRows.map(key));
    return (
      previous.identifiers.length !== incoming.size ||
      previous.identifiers.some((identifier) => !incoming.has(key(identifier)))
    );
  };

  const reconcileStableProjection = async (
    tx: Transaction,
    id: SafeId<"caseLawDecision">,
    projectionLock: ActiveCorpusProjectionSourceLock | null,
  ): Promise<void> => {
    if (
      projectionLock === null ||
      corpusPlan.type === "postgres-mirrored" ||
      corpusPlan.type === "object-storage"
    ) {
      return;
    }
    await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
      lock: projectionLock,
      subject: { family: "case_law", entityId: id },
    });
  };

  /**
   * The decision's judges, in the transaction that writes the row they belong
   * to. An observation that states none leaves the stored rows alone: only a
   * source that named judges can say the decision has different ones.
   */
  const writeDecisionJudges = async (
    tx: Transaction,
    writtenDecisionId: SafeId<"caseLawDecision">,
  ): Promise<void> => {
    if (result.judges === undefined) {
      return;
    }
    await judges.replace(tx, {
      decisionId: writtenDecisionId,
      judges: result.judges,
    });
  };

  /**
   * This attempt wrote raw objects for a decision that was erased before
   * its row write: they landed after, or may yet land after, the erasure's
   * own sweep. Recorded in the transaction that saw the erasure, so the
   * sweeper deletes them whatever becomes of this process.
   */
  const sweepRawWriteLostToErasureTx = async (
    tx: Transaction,
    id: SafeId<"caseLawDecision">,
  ): Promise<void> => {
    if (!rawWriteAttempted) {
      return;
    }
    await enqueueCaseLawRawSweepTx(tx, {
      decisionId: id,
      sourceId,
      firstAttemptAt: new Date(),
      settleAfter: rawSweepSettleAfter(),
    });
  };

  // The status of a write that another writer's row state turned away. The
  // payload fence is this observation's only when it still owns the row.
  const lostRowWriteStatus = async (
    tx: Transaction,
    id: SafeId<"caseLawDecision">,
    { payloadFenced }: { payloadFenced: boolean },
  ): Promise<DecisionRowWriteStatus> => {
    const winner = await tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: id } },
      columns: {
        corpusMirrorStatus: true,
        redactedAt: true,
        sourceObservationOrder: true,
      },
    });
    if (winner?.redactedAt) {
      await sweepRawWriteLostToErasureTx(tx, id);
      return DECISION_ROW_WRITE_STATUS.WINNER_REDACTED;
    }
    if (payloadFenced && observationStillOwns(winner, observationOrder)) {
      return DECISION_ROW_WRITE_STATUS.STALE_PAYLOAD;
    }
    return winner?.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
      ? DECISION_ROW_WRITE_STATUS.WINNER_PENDING
      : DECISION_ROW_WRITE_STATUS.WINNER_SETTLED;
  };

  const writeDecisionRow = async (
    slug?: string,
  ): Promise<DecisionRowWriteStatus> =>
    await scopedDb(async (tx) => {
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
        // A refresh with no document of its own may not overwrite one.
        // Ordinary empty refreshes therefore guard a separate payload
        // statement, while a pending-mirror repair claims its exact owner
        // token in the metadata-and-payload update. Both conditions are
        // evaluated with the write, where a concurrent materializer cannot
        // slip between the check and mutation.
        const payloadNeedsGuard =
          !incomingCarriesDocument &&
          pendingMirrorPayload === null &&
          Object.keys(payloadColumns).length > 0;

        // Read inside this transaction, before the write: the identity this
        // update replaces is what decides whether the citation graph moved,
        // and the snapshot taken in an earlier transaction can no longer say.
        const replacedState = preservesExistingDetail
          ? null
          : await replacedDecisionState(tx, existing.id);

        // The row's stated identity and description, as this observation
        // reads them. Compared against the stored row below so that
        // `updated_at` moves only when one of them, or the payload, does.
        const describedColumns = preservesExistingDetail
          ? {}
          : {
              caseNumber: result.caseNumber,
              citationKey: incomingCitationKey,
              sourceDocumentId: persistedSourceDocumentId,
              ecli: result.ecli,
              court: result.court,
              country: result.country,
              language: result.language,
              sheetNumber: result.sheetNumber,
              languageGroupKey,
              decisionDate: persistedDecisionDate,
              decisionType: result.decisionType,
              sourceUrl: result.sourceUrl,
              documentUrl: result.documentUrl,
              parserVersion: result.parserVersion ?? 0,
            };
        const describedMetadata = preservesExistingDetail
          ? undefined
          : preserveStoredTextAfterParseFailure({
              incomingMetadata: result.metadata,
              storedMetadata: replacedState?.metadata ?? null,
              textFields: result.textFields,
            });
        const describedMetadataSql: SQL =
          describedMetadata === undefined
            ? sql`${caseLawDecisions.metadata}`
            : sql`${JSON.stringify(describedMetadata)}::text::jsonb`;
        // An inline observation with no document marks a row that holds none
        // as listing-only. Decided in the statement, against the row's own
        // payload, which this statement leaves as it is whenever the marker
        // can apply: the document-less payload goes through its own guarded
        // statement below.
        const markedMetadata: SQL | undefined =
          storesUnpublishedWithoutDocument && pendingMirrorPayload === null
            ? sql`CASE WHEN ${rowHoldsDocument} THEN ${describedMetadataSql} ELSE ${metadataMarkedListingOnly(describedMetadataSql)} END`
            : undefined;
        const metadataWrite = markedMetadata ?? describedMetadata;
        const writtenPayload = payloadNeedsGuard ? {} : payloadColumns;
        const contentChanged = sql`(
          ${identifiersRewritten(replacedState)}::boolean
          OR ${payloadChangedSql(corpusPlan, writtenPayload)}
          OR ${storedRowDiffers(describedColumns)}
          OR ${caseLawDecisions.metadata} IS DISTINCT FROM ${markedMetadata ?? describedMetadataSql}
        )`;

        const updated = await tx
          .update(caseLawDecisions)
          .set({
            ...describedColumns,
            ...(metadataWrite === undefined ? {} : { metadata: metadataWrite }),
            ...(preservesExistingDetail
              ? {}
              : {
                  sourceRaw: null,
                  // A failed upload writes no pointer at all: the one this
                  // attempt read may since have been moved, and writing it
                  // back would point the row at an object nothing else
                  // accounts for any more.
                  ...(s3UploadFailed
                    ? {}
                    : { sourceRawS3Key, sourceRawContentType }),
                }),
            ...writtenPayload,
            // Partial observations preserve the authoritative detail hash.
            // When S3 upload failed, keeping the old hash also makes the next
            // cycle retry instead of permanently accepting a stale raw source.
            sourceHash:
              preservesExistingDetail || s3UploadFailed
                ? existing.sourceHash
                : result.rawHash,
            sourceObservedAt: observedAt,
            sourceObservationOrder: observationOrder,
            sourceObservationHash: result.rawHash,
            // A new observation of the same decision is not a modification:
            // the row moves in the recent-activity reads and the search
            // refresh only when what it says changed.
            updatedAt: sql`CASE WHEN ${contentChanged} THEN now() ELSE ${caseLawDecisions.updatedAt} END`,
          })
          .where(
            and(
              eq(caseLawDecisions.id, existing.id),
              storedObservationPrecedes({ order: observationOrder }),
              isNull(caseLawDecisions.redactedAt),
              corpusPlan.type === "preserve-stored"
                ? eq(
                    caseLawDecisions.corpusMirrorStatus,
                    CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
                  )
                : undefined,
              storedPayloadUnchanged
                ? and(
                    sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${existing.contentHash}`,
                    sql`${caseLawDecisions.textS3Key} IS NOT DISTINCT FROM ${existing.textS3Key}`,
                    sql`${caseLawDecisions.normalizedS3Key} IS NOT DISTINCT FROM ${existing.normalizedS3Key}`,
                    sql`${caseLawDecisions.astS3Key} IS NOT DISTINCT FROM ${existing.astS3Key}`,
                  )
                : undefined,
              pendingMirrorPayload === null
                ? undefined
                : and(
                    eq(
                      caseLawDecisions.corpusMirrorStatus,
                      CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
                    ),
                    sql`${caseLawDecisions.sourceObservationOrder} IS NOT DISTINCT FROM ${pendingMirrorPayload.sourceObservationOrder}`,
                    sql`${caseLawDecisions.sourceObservationHash} IS NOT DISTINCT FROM ${pendingMirrorPayload.sourceObservationHash}`,
                  ),
            ),
          )
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
          return await lostRowWriteStatus(tx, existing.id, {
            payloadFenced: storedPayloadUnchanged,
          });
        }

        if (payloadNeedsGuard) {
          // The row is locked by the update above, so what this reads is
          // what the write below would see. A row that holds a document is
          // not overwritten by one that carries none; a row that already
          // holds this document-less payload is not rewritten with it.
          const payloadState = (
            await tx
              .select({
                holdsDocument: rowHoldsDocument,
                differs: sql<boolean>`${storedRowDiffers(payloadColumns)}`,
              })
              .from(caseLawDecisions)
              .where(
                and(
                  eq(caseLawDecisions.id, existing.id),
                  isNull(caseLawDecisions.redactedAt),
                ),
              )
              .limit(1)
          ).at(0);
          if (payloadState === undefined || payloadState.holdsDocument) {
            return await lostRowWriteStatus(tx, existing.id, {
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
            identifierRows.map((identifier) => ({
              decisionId: existing.id,
              ...identifier,
            })),
          );
          await writeDecisionJudges(tx, existing.id);
        }

        if (
          replacedState !== null &&
          resolutionIdentityChanged(replacedState)
        ) {
          // Retract before announcing. The edges pointing here were decided
          // against the identity this decision no longer has, and the announce
          // path deliberately excludes its own links, so nothing else would
          // ever ask about them again.
          await reopenCitationsResolvedTo(tx, existing.id);
          // And the edges this decision *makes*. Its jurisdiction and date are
          // the resolver's policy and time filters, so moving either changes
          // what its own citations may match — a date moving forwards can
          // revive an unmatched one, moving backwards invalidates a resolved
          // one, and the walk excludes terminal rows either way.
          await reopenCitationsFrom(tx, existing.id);
          // The old key as well as the new one. An ambiguous citation carries
          // no target, so nothing that searches by target can reach it — and
          // this decision leaving its old key is exactly what can make the
          // remaining holder unique.
          await reopenCitationsForKeys(
            tx,
            [replacedState.citationKey, incomingCitationKey].filter(
              (key) => key !== null,
            ),
          );
          const affectedIdentifiers = [
            ...replacedState.identifiers,
            ...identifierRows,
          ].filter(
            (identifier, index, all) =>
              all.findIndex(
                (candidate) =>
                  candidate.type === identifier.type &&
                  candidate.normalizedValue === identifier.normalizedValue,
              ) === index,
          );
          await announceDecisionIdentifiers(
            tx,
            existing.id,
            affectedIdentifiers,
          );
        }

        // Citations are read out of the document, so a refresh that
        // carries no document has nothing to say about them either.
        if (!incomingCarriesDocument) {
          await reconcileStableProjection(tx, existing.id, projectionLock);
          return DECISION_ROW_WRITE_STATUS.APPLIED;
        }

        // The resolver locks the graph before it locks citation rows. Match
        // that order even when the decision identity did not change; taking
        // row locks first and the graph lock in resolve below can deadlock an
        // overlapping resolver batch. Re-entrant when a reopen helper above
        // already acquired it for this transaction.
        await lockCitationGraph(tx);
        await writeDecisionCitations(tx, {
          decisionId: existing.id,
          rows: citationRows,
          observedAt,
          stored: true,
        });

        await reconcileStableProjection(tx, existing.id, projectionLock);
        return DECISION_ROW_WRITE_STATUS.APPLIED;
      }

      if (slug === undefined) {
        panic("Missing slug for a new case-law decision");
      }

      const [decisionRow] = await tx
        .insert(caseLawDecisions)
        .values({
          id: decisionId,
          sourceId,
          caseNumber: result.caseNumber,
          sourceDocumentId: persistedSourceDocumentId,
          sheetNumber: result.sheetNumber,
          citationKey: incomingCitationKey,
          slug,
          ecli: result.ecli,
          court: result.court,
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
        })
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
        identifierRows.map((identifier) => ({
          decisionId: decisionRow.id,
          ...identifier,
        })),
      );
      await writeDecisionJudges(tx, decisionRow.id);

      await announceDecisionIdentifiers(tx, decisionRow.id, identifierRows);

      if (citationRows.length > 0) {
        // Settled as they are written, in the transaction that writes them.
        // One indexed lookup per citation against the fetch and parse this
        // page already paid for; without it every new citation waits for the
        // standing walk to come round, and the citator trails the crawl.
        await lockCitationGraph(tx);
        await writeDecisionCitations(tx, {
          decisionId: decisionRow.id,
          rows: citationRows,
          observedAt,
          stored: false,
        });
      }
      await reconcileStableProjection(tx, decisionRow.id, projectionLock);
      return DECISION_ROW_WRITE_STATUS.APPLIED;
    });

  // Pass the original error through: the pipeline's halt semantics inspect
  // its type (a TimeoutError holds the cursor), which a wrapper would hide.
  const slugIdentity = persistedSourceDocumentId
    ? `${sourceId}\u0000document\u0000${persistedSourceDocumentId}`
    : `${sourceId}\u0000case\u0000${result.caseNumber}\u0000${result.language}`;
  const baseSlug = createCaseLawDecisionSlug(result.caseNumber);

  let rowWrite = await Result.tryPromise({
    try: async () => await writeDecisionRow(existing ? undefined : baseSlug),
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
      try: async () => await writeDecisionRow(slug),
      catch: (cause: unknown) => cause,
    });
  }

  if (Result.isError(rowWrite)) {
    await recordAbandonedRawWrite();
    const isConcurrentIdentityInsert =
      isPgConstraintError(
        rowWrite.error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_source_document_idx",
      ) ||
      isPgConstraintError(
        rowWrite.error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_source_case_lang_null_idx",
      ) ||
      isPgConstraintError(
        rowWrite.error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_pkey",
      );
    if (isConcurrentIdentityInsert) {
      if (contentionReconciliation === CONTENTION_RECONCILIATION.RETRY) {
        return {
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          inserted: false,
          reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
        };
      }
      return await processDecisionAttempt({
        input,
        sourceId,
        scopedDb,
        observedAt,
        observationOrder,
        contentionReconciliation: CONTENTION_RECONCILIATION.RETRY,
        refresh,
        corpus,
        corpusBatch,
        judges,
        polarityRules,
      });
    }
    throw rowWrite.error;
  }

  const writeStatus = rowWrite.value;
  switch (writeStatus) {
    case DECISION_ROW_WRITE_STATUS.APPLIED: {
      // The judgment itself is written; a row left standing is not a reason
      // to observe it again. The reconciliation lists that supplement again.
      const absorbed = await absorbComposedSupplementRows({
        scopedDb,
        sourceId,
        judgmentId: decisionId,
        supplements: composedSupplements,
      });
      if (absorbed.type === "incomplete") {
        logger.warn(SUPPLEMENT_ABSORB_FAILED, {
          sourceId,
          judgmentId: decisionId,
          "error.detail": `left for reconciliation: ${absorbed.sourceDocumentIds.join(", ")}`,
        });
      }
      break;
    }
    case DECISION_ROW_WRITE_STATUS.SUPPLEMENTS_MOVED:
      if (contentionReconciliation === CONTENTION_RECONCILIATION.RETRY) {
        return {
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          inserted: false,
          reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
        };
      }
      return await processDecisionAttempt({
        input,
        sourceId,
        scopedDb,
        observedAt,
        observationOrder,
        contentionReconciliation: CONTENTION_RECONCILIATION.RETRY,
        refresh,
        corpus,
        corpusBatch,
        judges,
        polarityRules,
      });
    case DECISION_ROW_WRITE_STATUS.WINNER_PENDING:
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: false,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      };
    case DECISION_ROW_WRITE_STATUS.WINNER_REDACTED:
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: false,
        searchVectorFailed: false,
      };
    case DECISION_ROW_WRITE_STATUS.WINNER_SETTLED:
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: false,
        searchVectorFailed: false,
      };
    case DECISION_ROW_WRITE_STATUS.STALE_PAYLOAD:
      if (contentionReconciliation === CONTENTION_RECONCILIATION.RETRY) {
        return {
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          inserted: false,
          reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
        };
      }
      return await processDecisionAttempt({
        input,
        sourceId,
        scopedDb,
        observedAt,
        observationOrder,
        contentionReconciliation: CONTENTION_RECONCILIATION.RETRY,
        refresh,
        corpus,
        corpusBatch,
        judges,
        polarityRules,
      });
    default:
      writeStatus satisfies never;
      return panic(`Unhandled write status: ${String(writeStatus)}`);
  }

  if (
    corpusPlan.type === "postgres-mirrored" ||
    corpusPlan.type === "object-storage"
  ) {
    // The sourceHash this call just persisted: corpus-key and retry
    // updates only apply while the row still carries it. The upload helper
    // holds the same row fence as redaction across the bounded object write.
    const persistedSourceHash =
      preservesExistingDetail || s3UploadFailed
        ? (existing?.sourceHash ?? null)
        : result.rawHash;
    {
      const ownerPredicate = and(
        eq(caseLawDecisions.id, decisionId),
        sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${persistedSourceHash}`,
        eq(caseLawDecisions.sourceObservationOrder, observationOrder),
        eq(
          caseLawDecisions.corpusMirrorStatus,
          CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
        ),
        isNull(caseLawDecisions.redactedAt),
        mirrorCarriesDocument
          ? undefined
          : sql`NOT ${pgPayloadCarriesDocument}`,
      );
      // The payloads join the batch's pack rather than being PUT here. The
      // settlement below runs once that pack is durable, under the same row
      // fence redaction takes.
      const batch =
        corpusBatch ??
        openCorpusPackBatch({ scopedDb, transfer: corpus.transfer });
      batch.enqueue({
        decisionId,
        jurisdiction: corpusPayload.jurisdiction,
        payload: corpusPayload,
        // From the pre-write snapshot: the row update above moved the mirror
        // to pending, but a settled record in that snapshot still proves
        // those payloads were confirmed, so an identical one need not be
        // written again.
        stored: existing === undefined ? null : storedCorpusWrite(existing),
        settle: async ({ intentId, written }) => {
          const upload = await settleReservedCaseLawCorpusUpload({
            apply: async ({ projectionLock, tx, written: settled }) => {
              const applied = await settleCaseLawCorpusMirrorTx({
                decisionId,
                persistedSourceHash,
                observationOrder,
                mirrorCarriesDocument,
                mode: corpus.mode,
                tx,
                written: settled,
              });
              if (!applied) {
                return { type: "superseded" };
              }
              if (projectionLock !== null) {
                await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
                  lock: projectionLock,
                  subject: { family: "case_law", entityId: decisionId },
                });
              }
              return { type: "applied" };
            },
            decisionId,
            intentId,
            preflight: async (tx) =>
              Boolean(
                (
                  await tx
                    .select({ id: caseLawDecisions.id })
                    .from(caseLawDecisions)
                    .where(ownerPredicate)
                    .limit(1)
                ).at(0),
              ),
            scopedDb,
            written,
          });
          if (upload.type === "redacted-or-missing") {
            return { type: "redacted-or-missing" };
          }
          if (
            upload.type === "intent-reclaimed" ||
            upload.type === "superseded"
          ) {
            const winner = await scopedDb((tx) =>
              tx.query.caseLawDecisions.findFirst({
                where: { id: { eq: decisionId } },
                columns: { corpusMirrorStatus: true, redactedAt: true },
              }),
            );
            if (winner?.redactedAt || !winner) {
              return { type: "redacted-or-missing" };
            }
            if (
              winner.corpusMirrorStatus ===
              CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
            ) {
              return { type: "retry" };
            }
          }
          return { type: "settled" };
        },
      });
      if (corpusBatch === undefined) {
        // Nobody else will flush this batch, so this decision is its own:
        // one transfer, one member set, the same path a page takes.
        const flushed = await batch.flush();
        return withSourceRawRetry(
          processResultForCorpusOutcome(
            Result.isError(flushed)
              ? { type: "failed", error: flushed.error }
              : flushed.value.get(decisionId),
            {
              decisionId,
              caseNumber: result.caseNumber,
              country: result.country,
            },
          ),
        );
      }
    }
  }

  // Search indexing (tsvector) is handled by a background
  // backfill loop so the slow to_tsvector + unaccent computation
  // doesn't block cursor advancement. New decisions become
  // searchable within ~30s of insertion.

  return withSourceRawRetry({
    status: PROCESS_DECISION_STATUS.COMPLETE,
    inserted: true,
    searchVectorFailed: false,
  });
};

export const processDecision = async ({
  refresh = DECISION_REFRESH.WHEN_SOURCE_CHANGED,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
  judges = CASE_LAW_JUDGE_DEPENDENCIES,
  ...options
}: ProcessDecisionOptions): Promise<ProcessResult> =>
  await processDecisionAttempt({
    ...options,
    contentionReconciliation: CONTENTION_RECONCILIATION.INITIAL,
    refresh,
    corpus,
    judges,
  });
