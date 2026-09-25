import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
} from "@/api/db/schema";
import {
  lockCitationGraph,
  reopenCitationsForKeys,
  reopenCitationsFrom,
  reopenCitationsResolvedTo,
} from "@/api/handlers/case-law/citation-resolution";
import { writeDecisionCitations } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import {
  payloadChangedSql,
  rowHoldsDocument,
  storedRowDiffers,
} from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import type { ExistingDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import type { DecisionWritePlan } from "@/api/handlers/case-law/ingestion/pipeline/decision-plan";
import { sweepRawWriteLostToErasureTx } from "@/api/handlers/case-law/ingestion/pipeline/decision-raw";
import {
  announceDecisionIdentifiers,
  reconcileStableProjection,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-row-context";
import type { DecisionRowWrite } from "@/api/handlers/case-law/ingestion/pipeline/decision-row-context";
import {
  observationStillOwns,
  storedObservationPrecedes,
} from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { DECISION_ROW_WRITE_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { DecisionRowWriteStatus } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import { preserveStoredTextAfterParseFailure } from "@/api/lib/case-law/decision-text";
import type { ActiveCorpusProjectionSourceLock } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";

type IdentifierType = DecisionWritePlan["identifierRows"][number]["type"];

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
    type: IdentifierType;
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

type ReplacedDecisionState = NonNullable<
  Awaited<ReturnType<typeof replacedDecisionState>>
>;

const resolutionIdentityChanged = (
  {
    result,
    persistedDecisionDate,
    plan: { identifierRows, incomingCitationKey },
  }: DecisionRowWrite,
  previous: {
    citationKey: string | null;
    country: string;
    language: string;
    decisionDate: string | null;
    identifiers: {
      type: IdentifierType;
      normalizedValue: string;
    }[];
  },
): boolean => {
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
  { plan: { identifierRows } }: DecisionRowWrite,
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

// The status of a write that another writer's row state turned away. The
// payload fence is this observation's only when it still owns the row.
export const lostRowWriteStatus = async (
  tx: Transaction,
  { observationOrder, rawWrites, sourceId }: DecisionRowWrite,
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
    await sweepRawWriteLostToErasureTx(tx, { rawWrites, id, sourceId });
    return DECISION_ROW_WRITE_STATUS.WINNER_REDACTED;
  }
  if (payloadFenced && observationStillOwns(winner, observationOrder)) {
    return DECISION_ROW_WRITE_STATUS.STALE_PAYLOAD;
  }
  return winner?.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
    ? DECISION_ROW_WRITE_STATUS.WINNER_PENDING
    : DECISION_ROW_WRITE_STATUS.WINNER_SETTLED;
};

/**
 * The refresh's update of the row: its description, metadata, raw pointer
 * and (unless guarded) payload, fenced on this observation still owning the
 * row. Reads the state it replaces, under a row lock; the caller runs it.
 */
export const describeRowUpdateTx = async (
  tx: Transaction,
  write: DecisionRowWrite,
  existing: ExistingDecision,
) => {
  const {
    result,
    observedAt,
    observationOrder,
    persistedSourceDocumentId,
    persistedDecisionDate,
    shape: {
      incomingCarriesDocument,
      preservesExistingDetail,
      storesUnpublishedWithoutDocument,
    },
    plan: {
      corpusPlan,
      incomingCitationKey,
      languageGroupKey,
      payloadColumns,
      pendingMirrorPayload,
      storedPayloadUnchanged,
    },
    rawArtifact: { s3UploadFailed, sourceRawS3Key, sourceRawContentType },
  } = write;
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
    ${identifiersRewritten(write, replacedState)}::boolean
    OR ${payloadChangedSql(corpusPlan, writtenPayload)}
    OR ${storedRowDiffers(describedColumns)}
    OR ${caseLawDecisions.metadata} IS DISTINCT FROM ${markedMetadata ?? describedMetadataSql}
  )`;

  const set = {
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
          ...(s3UploadFailed ? {} : { sourceRawS3Key, sourceRawContentType }),
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
  };
  const where = and(
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
  );

  return { replacedState, payloadNeedsGuard, set, where };
};

/**
 * Whether the row holds a document, and whether this document-less payload
 * differs from what it holds, read under the lock the row update took.
 * Undefined when the row is gone or erased.
 */
export const readDocumentlessPayloadStateTx = async (
  tx: Transaction,
  { plan: { payloadColumns } }: DecisionRowWrite,
  existing: ExistingDecision,
) =>
  (
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

/**
 * Reopen the citations this decision's identity change affects: those
 * pointing here, those it makes, and those keyed on its old or new key.
 */
const reopenMovedIdentityTx = async (
  tx: Transaction,
  write: DecisionRowWrite,
  existing: ExistingDecision,
  replacedState: ReplacedDecisionState,
): Promise<void> => {
  const {
    plan: { identifierRows, incomingCitationKey },
  } = write;
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
    write,
    existing.id,
    affectedIdentifiers,
  );
};

/**
 * Finish a refreshed row in the row write's transaction, after its columns
 * and identifiers are written: reopen what its identity change affects,
 * then rewrite its citations under the citation-graph lock.
 */
export const finishRefreshedRowTx = async (
  tx: Transaction,
  write: DecisionRowWrite,
  existing: ExistingDecision,
  replacedState: ReplacedDecisionState | null,
  projectionLock: ActiveCorpusProjectionSourceLock | null,
): Promise<DecisionRowWriteStatus> => {
  const {
    observedAt,
    shape: { incomingCarriesDocument },
    plan: { citationRows },
  } = write;
  if (
    replacedState !== null &&
    resolutionIdentityChanged(write, replacedState)
  ) {
    await reopenMovedIdentityTx(tx, write, existing, replacedState);
  }

  // Citations are read out of the document, so a refresh that
  // carries no document has nothing to say about them either.
  if (!incomingCarriesDocument) {
    await reconcileStableProjection(tx, write, existing.id, projectionLock);
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

  await reconcileStableProjection(tx, write, existing.id, projectionLock);
  return DECISION_ROW_WRITE_STATUS.APPLIED;
};
