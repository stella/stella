import { panic } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
} from "@/api/db/schema";
import type { CitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import {
  reopenCitationsForKeys,
  reopenCitationsFrom,
  reopenCitationsResolvedTo,
} from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_SCOPE_METADATA_KEY,
  preserveCitationScopeEnvelope,
} from "@/api/handlers/case-law/ingestion/citation-scopes";
import { writeDecisionCitations } from "@/api/handlers/case-law/ingestion/pipeline/citations";
import {
  payloadChangedSql,
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
import { rowHoldsDocument } from "@/api/lib/case-law/stored-payload";
import type { ActiveCorpusProjectionSourceLock } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { sortDeep } from "@/api/lib/sort-deep";

type IdentifierType = DecisionWritePlan["identifierRows"][number]["type"];

/** Decision state locked immediately before this transaction overwrites it. */
const replacedDecisionState = async (
  tx: CitationGraphTransaction<Transaction>,
  id: SafeId<"caseLawDecision">,
): Promise<{
  citationKey: string | null;
  country: string;
  language: string;
  decisionDate: string | null;
  holdsDocument: boolean;
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
      holdsDocument: sql<boolean>`${rowHoldsDocument}`,
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
      declaredAt: caseLawDecisionIdentifiers.declaredAt,
    })
    .from(caseLawDecisionIdentifiers)
    .where(eq(caseLawDecisionIdentifiers.decisionId, id));
  return { ...row, identifiers };
};

/**
 * The stored identifier rows an observation answers for: the observed ones,
 * and a declared alias only where this observation derives it too. A declared
 * alias it does not derive is kept by the write and is no change of it.
 */
const observedIdentifiers = <
  T extends { type: string; normalizedValue: string; declaredAt?: Date | null },
>(
  stored: readonly T[],
  incoming: DecisionWritePlan["identifierRows"],
): T[] => {
  const derived = new Set(
    incoming.map(
      (identifier) => `${identifier.type}\u0000${identifier.normalizedValue}`,
    ),
  );
  return stored.filter(
    (identifier) =>
      identifier.declaredAt === null ||
      identifier.declaredAt === undefined ||
      derived.has(`${identifier.type}\u0000${identifier.normalizedValue}`),
  );
};

type ReplacedDecisionState = NonNullable<
  Awaited<ReturnType<typeof replacedDecisionState>>
>;

type LockedCitationScopeStateOptions = {
  incomingCarriesDocument: boolean;
  preparedMetadata: DecisionWritePlan["preparedMetadata"];
  replacedState: ReplacedDecisionState | null;
  reusedCitationScopeEnvelope: DecisionWritePlan["reusedCitationScopeEnvelope"];
};

const lockedCitationScopeState = ({
  incomingCarriesDocument,
  preparedMetadata,
  replacedState,
  reusedCitationScopeEnvelope,
}: LockedCitationScopeStateOptions) => {
  const preservesDocument =
    !incomingCarriesDocument && replacedState?.holdsDocument === true;
  return {
    stale:
      preservesDocument &&
      JSON.stringify(
        sortDeep(replacedState.metadata?.[CITATION_SCOPE_METADATA_KEY] ?? null),
      ) !== JSON.stringify(sortDeep(reusedCitationScopeEnvelope ?? null)),
    metadata: preservesDocument
      ? preserveCitationScopeEnvelope(preparedMetadata, replacedState.metadata)
      : preparedMetadata,
  };
};

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
      declaredAt?: Date | null;
    }[];
  },
): boolean => {
  const stored = observedIdentifiers(previous.identifiers, identifierRows);
  const incoming = new Set(
    identifierRows.map(
      (identifier) => `${identifier.type}:${identifier.normalizedValue}`,
    ),
  );
  const identifiersChanged =
    stored.length !== incoming.size ||
    stored.some(
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
      declaredAt?: Date | null;
    }[];
  } | null,
): boolean => {
  if (previous === null) {
    return false;
  }
  const stored = observedIdentifiers(previous.identifiers, identifierRows);
  const key = (identifier: {
    type: string;
    normalizedValue: string;
    value: string;
  }) =>
    `${identifier.type}\u0000${identifier.normalizedValue}\u0000${identifier.value}`;
  const incoming = new Set(identifierRows.map(key));
  return (
    stored.length !== incoming.size ||
    stored.some((identifier) => !incoming.has(key(identifier)))
  );
};

// The status of a write that another writer's row state turned away. The
// payload fence is this observation's only when it still owns the row.
export const lostRowWriteStatus = async (
  tx: CitationGraphTransaction<Transaction>,
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
  tx: CitationGraphTransaction<Transaction>,
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
      docketColumns,
      languageGroupKey,
      payloadColumns,
      pendingMirrorPayload,
      preparedMetadata,
      reusedCitationScopeEnvelope,
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
  const scopeState = lockedCitationScopeState({
    incomingCarriesDocument,
    preparedMetadata,
    replacedState,
    reusedCitationScopeEnvelope,
  });

  // The row's stated identity and description, as this observation
  // reads them. Compared against the stored row below so that
  // `updated_at` moves only when one of them, or the payload, does.
  // The file key is derived, never stated: filling it on a row keyed before
  // it existed is not a change to what the decision says.
  const { docketFamilyKey, ...statedDocketColumns } = docketColumns;
  const describedColumns = preservesExistingDetail
    ? {}
    : {
        ...statedDocketColumns,
        sourceDocumentId: persistedSourceDocumentId,
        ecli: result.ecli,
        court: result.court,
        courtId: result.courtId ?? null,
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
        incomingMetadata: scopeState.metadata,
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
    ...(preservesExistingDetail ? {} : { docketFamilyKey }),
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

  return {
    replacedState,
    payloadNeedsGuard,
    set,
    staleCitationScopePayload: scopeState.stale,
    where,
  };
};

/**
 * Whether the row holds a document, and whether this document-less payload
 * differs from what it holds, read under the lock the row update took.
 * Undefined when the row is gone or erased.
 */
export const readDocumentlessPayloadStateTx = async (
  tx: CitationGraphTransaction<Transaction>,
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
  tx: CitationGraphTransaction<Transaction>,
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
  // And, when this source writes graph rows, the edges this decision
  // *makes*. Its jurisdiction and date are the resolver's policy and time
  // filters, so moving either changes what those citations may match.
  if (write.plan.citations.disposition === "legacy-graph") {
    await reopenCitationsFrom(tx, existing.id);
  }
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
  tx: CitationGraphTransaction<Transaction>,
  write: DecisionRowWrite,
  existing: ExistingDecision,
  replacedState: ReplacedDecisionState | null,
  projectionLock: ActiveCorpusProjectionSourceLock | null,
): Promise<DecisionRowWriteStatus> => {
  const {
    observedAt,
    shape: { incomingCarriesDocument },
    plan: { citations },
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

  switch (citations.disposition) {
    case "annotation-only":
      break;
    case "legacy-graph":
      // The row writer owns the graph before any decision or citation rows.
      await writeDecisionCitations(tx, {
        decisionId: existing.id,
        citations,
        observedAt,
        stored: true,
      });
      break;
    default:
      citations satisfies never;
      panic("Unhandled citation disposition");
  }

  await reconcileStableProjection(tx, write, existing.id, projectionLock);
  return DECISION_ROW_WRITE_STATUS.APPLIED;
};
