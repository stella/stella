import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { docketFamilyKeysToRead } from "@stll/api-contract/decision-docket-reference";
import { compareCodeUnit } from "@stll/collation";
import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
} from "@stll/legal-ast/decision-identifier";
import { sha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawHeldDecisionAttachments,
} from "@/api/db/schema";
import {
  type CitationGraphTransaction,
  runCitationGraphTransaction,
} from "@/api/handlers/case-law/citation-graph-transaction";
import {
  declareDecisionIdentifiersTx,
  withdrawAttachmentIdentifiersTx,
} from "@/api/handlers/case-law/decision-identifier-claims-persistence";
import { normalizeDecisionIdentifierIn } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  clearUnbackedSourceIdentitiesTx,
  lockSourceIdentitiesTx,
  type ObservedDecision,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import type { DecisionRowWrite } from "@/api/handlers/case-law/ingestion/pipeline/decision-row-context";
import {
  clearIngestionFailureEvidenceTx,
  type IngestionFailureEvidenceError,
  parkIngestionFailureTx,
} from "@/api/handlers/case-law/ingestion/pipeline/failure-evidence-persistence";
import {
  PROCESS_DECISION_RETRY_REASON,
  PROCESS_DECISION_STATUS,
  type ProcessResult,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { writeOwnedRawPayload } from "@/api/handlers/case-law/ingestion/pipeline/raw-payload";
import {
  type AttemptStep,
  RECONCILE_CONTENTION,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
import {
  heldDecisionEcliIdentity,
  readHeldDecisionCandidates,
} from "@/api/lib/case-law/held-decision-candidate-query";
import { replayWrite } from "@/api/lib/case-law/replay-write";
import { lockCaseLawDecisionRows } from "@/api/lib/db/aggregate-lock";
import { type BoundedReadResult, readBounded } from "@/api/lib/db/read-bounded";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import {
  COLLECTION_DOCUMENT_BODY_CONTENT_TYPE,
  type CollectionDocumentPart,
  encodeCollectionDocumentBody,
  validateCollectionDocumentPart,
} from "@/api/lib/legal-search/collection-document-part";
import { payloadCarriesDocument } from "@/api/lib/legal-search/corpus-content-hash";
import {
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { HELD_DECISION_ATTACHMENTS } from "@/api/lib/legal-search/held-decision-attachment";
import type { HeldDecisionAttachment } from "@/api/lib/legal-search/held-decision-attachment";
import {
  HELD_DECISION_AMBIGUOUS_CANDIDATES_MAX,
  HELD_DECISION_MATCH_BASIS,
  HELD_DECISION_REVIEW,
  type HeldDecisionAttachingBasis,
  type HeldDecisionDeclaredIdentifier,
  type HeldDecisionMatchBasis,
  type HeldDecisionMatchEvidence,
  type HeldDecisionReview,
} from "@/api/lib/legal-search/held-decision-attachment-values";
import { resolveHeldDecisionCandidates } from "@/api/lib/legal-search/held-decision-candidates";
import type { RawSourceWriteWindow } from "@/api/lib/legal-search/raw-source-storage";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { S3CredentialRefreshOptions } from "@/api/lib/s3/credential-guard";
import { sortDeep } from "@/api/lib/sort-deep";

/** A record attached to, or refreshed on, the held decision it names. */
const HELD_DECISION_ATTACHED = "case_law.ingestion.held_decision_attached";

/**
 * Several held decisions match a record, so it is parked with no row of its
 * own: an operator reads the candidates off its attachment row.
 */
const HELD_DECISION_AMBIGUOUS = "case_law.ingestion.held_decision_ambiguous";

/**
 * A record's court and docket are held only under another decision date, so
 * it is parked for review; the declaration chose that over a row of its own.
 */
const HELD_DECISION_DOCKET_OTHER_DATE =
  "case_law.ingestion.held_decision_docket_other_date";

/** A record's host was erased or redacted, so the record is parked. */
const HELD_DECISION_WITHDRAWN = "case_law.ingestion.held_decision_withdrawn";

/** The record's raw payload could not be stored under its host's prefix. */
const heldDecisionRawWriteFailed = failureSink({
  event: "case_law.ingestion.held_decision_raw_write_failed",
  expected: [],
});

/** What became of one record of a declaring source. */
type HeldDecisionAttachmentDisposition =
  | {
      type: "attached";
      hostDecisionId: SafeId<"caseLawDecision">;
      basis: HeldDecisionMatchBasis;
    }
  /** Already attached in this version, or a later observation is stored. */
  | { type: "unchanged"; hostDecisionId: SafeId<"caseLawDecision"> }
  | { type: "stale" }
  | {
      type: "review";
      review: HeldDecisionReview;
      evidence?: Exclude<HeldDecisionMatchEvidence, { status: "matched" }>;
      basis: HeldDecisionMatchBasis;
      candidateDecisionIds: SafeId<"caseLawDecision">[];
    }
  | { type: "withdrawn"; hostDecisionId: SafeId<"caseLawDecision"> };

/**
 * The attach step's answer: write the record as a decision of its own, or
 * the attempt's outcome, settled here.
 */
export type HeldDecisionAttachmentStep =
  | { type: "own-row" }
  | {
      type: "settled";
      step: AttemptStep;
      disposition: HeldDecisionAttachmentDisposition | null;
    };

type HostDecision = {
  id: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  redactedAt: Date | null;
  ecli: string | null;
};

type HostMatch =
  | { type: "none" }
  | { type: "one"; basis: HeldDecisionAttachingBasis; host: HostDecision }
  | Extract<HeldDecisionAttachmentDisposition, { type: "review" }>;

export type AttachToHeldDecisionOptions = {
  declaration: HeldDecisionAttachment<string>;
  observation: ObservedDecision;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observedAt: Date;
  observationOrder: bigint;
  /**
   * Opened before the read that proves the host is not erased, so the raw
   * write under the host's prefix starts within the window of that read.
   */
  rawWindow: RawSourceWriteWindow;
  signal?: AbortSignal;
  s3Policy?: S3CredentialRefreshOptions;
  /** Boundary for storing immutable payloads under the selected host owner. */
  rawPayloadWriter?: typeof writeOwnedRawPayload;
};

const COMPLETE: ProcessResult = {
  status: PROCESS_DECISION_STATUS.COMPLETE,
  inserted: false,
  searchVectorFailed: false,
};

const settled = (
  disposition: HeldDecisionAttachmentDisposition | null,
  step: AttemptStep = COMPLETE,
): HeldDecisionAttachmentStep => ({ type: "settled", step, disposition });

const HOST_COLUMNS = {
  id: caseLawDecisions.id,
  sourceId: caseLawDecisions.sourceId,
  redactedAt: caseLawDecisions.redactedAt,
  ecli: caseLawDecisions.ecli,
};

/**
 * The held decisions the record names: by its stated ECLI where any host
 * decision carries it as an identifier, otherwise by court, docket and
 * decision date. A redacted host still matches: the takedown covers the
 * record too, which is the caller's to settle.
 */
export const matchHostDecisionsTx = async (
  tx: Transaction,
  {
    declaration,
    observation: { observed, persistedDecisionDate },
    sourceId,
  }: Pick<
    AttachToHeldDecisionOptions,
    "declaration" | "observation" | "sourceId"
  >,
): Promise<HostMatch> => {
  const ecliIdentity = heldDecisionEcliIdentity(
    observed.country,
    observed.ecli,
  );
  const primaryEcliValues = ecliIdentity?.primaryValues ?? [];
  const ecliKeys = ecliIdentity?.keys ?? [];
  const docketKeys = docketFamilyKeysToRead(
    observed.caseNumber,
    observed.country,
  );
  const queryOptions = {
    country: observed.country,
    court: observed.court,
    courtId: observed.courtId,
    sourceId,
    collectionAdapterKeys: Object.keys(HELD_DECISION_ATTACHMENTS),
  };
  const readPaths = async (role: "host" | "collection") => ({
    ecli:
      ecliKeys.length === 0
        ? { type: "complete" as const, rows: [] }
        : await readHeldDecisionCandidates(tx, {
            ...queryOptions,
            role,
            path: {
              basis: "ecli",
              keys: ecliKeys,
              primaryValues: primaryEcliValues,
            },
          }),
    courtDocketDate:
      persistedDecisionDate === null ||
      persistedDecisionDate === undefined ||
      observed.caseNumber.length === 0
        ? { type: "complete" as const, rows: [] }
        : await readHeldDecisionCandidates(tx, {
            ...queryOptions,
            role,
            path: {
              basis: "court-docket-date",
              decisionDate: persistedDecisionDate,
              docketKeys,
              caseNumber: observed.caseNumber,
            },
          }),
  });
  const hosts = await readPaths("host");
  const collections = await readPaths("collection");
  const matched = resolveHeldDecisionCandidates({ hosts, collections });
  switch (matched.status) {
    case "matched":
      if (
        matched.candidate.sourceId !== sourceId &&
        !declaration.hostAdapterKeys.includes(matched.candidate.adapterKey)
      ) {
        return {
          type: "review",
          review: HELD_DECISION_REVIEW.SOURCE_POLICY,
          basis: HELD_DECISION_MATCH_BASIS.SOURCE_POLICY,
          candidateDecisionIds: [matched.candidate.id],
          evidence: {
            status: "outside-policy",
            adapterKey: matched.candidate.adapterKey,
          },
        };
      }
      return { type: "one", basis: matched.basis, host: matched.candidate };
    case "conflict":
      return {
        type: "review",
        review: HELD_DECISION_REVIEW.SEVERAL_HELD,
        basis: HELD_DECISION_MATCH_BASIS.ECLI,
        evidence: {
          status: "conflict",
          ecliCandidateIds: matched.ecliCandidates.map(({ id }) => id),
          courtDocketDateCandidateIds: matched.courtDocketDateCandidates.map(
            ({ id }) => id,
          ),
        },
        candidateDecisionIds: [
          ...new Set(
            [
              ...matched.ecliCandidates,
              ...matched.courtDocketDateCandidates,
            ].map(({ id }) => id),
          ),
        ].slice(0, HELD_DECISION_AMBIGUOUS_CANDIDATES_MAX),
      };
    case "ambiguous":
      return {
        type: "review",
        review: HELD_DECISION_REVIEW.SEVERAL_HELD,
        basis: matched.basis,
        evidence: { status: "ambiguous", completeness: matched.completeness },
        candidateDecisionIds: matched.candidates.map(({ id }) => id),
      };
    case "absent":
      break;
    default:
      matched satisfies never;
      return panic("Unhandled held candidate resolution");
  }
  if (
    observed.caseNumber.length === 0 ||
    declaration.docketHeldUnderOtherDate === "own-row"
  ) {
    return { type: "none" };
  }
  const otherDates = await readHeldDecisionCandidates(tx, {
    ...queryOptions,
    role: "host",
    path: {
      basis: "court-docket-other-date",
      docketKeys,
      caseNumber: observed.caseNumber,
    },
  });
  if (otherDates.type === "complete" && otherDates.rows.length === 0) {
    return { type: "none" };
  }
  return {
    type: "review",
    review: HELD_DECISION_REVIEW.DOCKET_HELD_OTHER_DATE,
    basis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_OTHER_DATE,
    candidateDecisionIds:
      otherDates.type === "complete" ? otherDates.rows.map(({ id }) => id) : [],
  };
};

/** The host a stored attachment names, through any alias it was retired into. */
const readHostTx = async (
  tx: Transaction,
  hostDecisionId: SafeId<"caseLawDecision">,
): Promise<HostDecision | undefined> =>
  (
    await tx
      .select(HOST_COLUMNS)
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, canonicalDecisionIdSql(hostDecisionId)))
      .limit(1)
  ).at(0);

/** Canonicalize every proven publisher binding before deciding whether a new row is safe. */
const readPublisherOwnersTx = async (
  tx: Transaction,
  {
    sourceId,
    observation: { exactSourceIdentityCandidates },
  }: Pick<AttachToHeldDecisionOptions, "sourceId" | "observation">,
): Promise<BoundedReadResult<HostDecision>> => {
  const canonicalIds = tx
    .select({
      id: canonicalDecisionIdSql(caseLawDecisionSourceIdentities.decisionId).as(
        "id",
      ),
    })
    .from(caseLawDecisionSourceIdentities)
    .where(
      and(
        eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
        inArray(
          caseLawDecisionSourceIdentities.sourceDocumentId,
          exactSourceIdentityCandidates,
        ),
      ),
    )
    .union(
      tx
        .select({ id: canonicalDecisionIdSql(caseLawDecisions.id).as("id") })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            inArray(
              caseLawDecisions.sourceDocumentId,
              exactSourceIdentityCandidates,
            ),
          ),
        ),
    );
  return await readBounded(
    tx
      .selectDistinct(HOST_COLUMNS)
      .from(caseLawDecisions)
      .where(inArray(caseLawDecisions.id, canonicalIds))
      .orderBy(caseLawDecisions.id),
    1,
  );
};

const attachmentKey = (
  sourceId: SafeId<"caseLawSource">,
  sourceDocumentId: string,
) =>
  and(
    eq(caseLawHeldDecisionAttachments.sourceId, sourceId),
    eq(caseLawHeldDecisionAttachments.sourceDocumentId, sourceDocumentId),
  );

/**
 * The record's attachment row. Every ingestion writer of it holds the
 * record's publisher-identity locks, and the erasure that parks it holds its
 * host's row, which the write below locks as well.
 */
const readAttachmentTx = async (
  tx: Transaction,
  sourceId: SafeId<"caseLawSource">,
  sourceDocumentId: string,
) =>
  (
    await tx
      .select()
      .from(caseLawHeldDecisionAttachments)
      .where(attachmentKey(sourceId, sourceDocumentId))
      .limit(1)
  ).at(0);

type StoredAttachment = NonNullable<
  Awaited<ReturnType<typeof readAttachmentTx>>
>;

/**
 * Park an attachment whose host is gone or redacted. Its metadata and raw
 * pointer go with the takedown; the raw object itself lives under the host's
 * prefix and goes with the host's sweep.
 */
const parkWithdrawnTx = async (
  tx: Transaction,
  stored: StoredAttachment,
  host: HostDecision | undefined,
): Promise<HeldDecisionAttachmentDisposition> => {
  const hostDecisionId = host?.id ?? stored.hostDecisionId;
  if (hostDecisionId === null) {
    return panic("A parked withdrawn attachment needs its host");
  }
  // audit: skip — background case-law ingestion; public case-law data
  const write = replayWrite(
    caseLawHeldDecisionAttachments,
    {
      hostDecisionId,
      hostWithdrawnAt: new Date(),
      metadata: null,
      sourceRawS3Key: null,
      sourceRawContentType: null,
      documentPart: null,
      documentBodyS3Key: null,
      documentBodySha256: null,
    },
    {
      modifiedAt: {
        column: caseLawHeldDecisionAttachments.updatedAt,
        value: new Date(),
      },
    },
  );
  await tx
    .update(caseLawHeldDecisionAttachments)
    .set(write.set)
    .where(
      and(
        attachmentKey(stored.sourceId, stored.sourceDocumentId),
        write.setWhere,
      ),
    );
  logger.warn(HELD_DECISION_WITHDRAWN, {
    sourceId: stored.sourceId,
    sourceDocumentId: stored.sourceDocumentId,
    hostDecisionId,
  });
  return { type: "withdrawn", hostDecisionId };
};

/** What the first transaction decided for the record. */
type AttachmentPlan =
  | { type: "refused"; error: IngestionFailureEvidenceError }
  | { type: "settled"; step: HeldDecisionAttachmentStep }
  | {
      type: "attach";
      writeRoute: "own-row" | "attachment";
      host: HostDecision;
      basis: HeldDecisionAttachingBasis;
      stored: StoredAttachment | undefined;
    };

const readTypedMetadata = (
  declaration: HeldDecisionAttachment<string>,
  observed: ObservedDecision["observed"],
): Result<
  Readonly<Record<string, unknown>>,
  UnpersistableDecisionFieldError
> => {
  const parsed = v.safeParse(
    declaration.metadataSchema,
    observed.metadata[declaration.metadataKey],
  );
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new UnpersistableDecisionFieldError({
          message: `Held-decision attachment metadata does not match its schema: ${v.summarize(parsed.issues).slice(0, 200)}`,
          field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
        }),
      );
};

/** The identifier rows the record declares on its host, in a stable order. */
const declaredIdentifiersOf = (
  declaration: HeldDecisionAttachment<string>,
  observed: ObservedDecision["observed"],
): HeldDecisionDeclaredIdentifier[] => {
  const types = new Set<string>(declaration.declaredIdentifierTypes);
  const byKey = new Map<string, HeldDecisionDeclaredIdentifier>();
  if (observed.identifiers === undefined) {
    return [];
  }
  for (const identifier of observed.identifiers) {
    if (!types.has(identifier.type)) {
      continue;
    }
    const normalizedValue = normalizeDecisionIdentifierIn(
      observed.country,
      identifier,
    );
    if (normalizedValue.length === 0) {
      continue;
    }
    byKey.set(`${identifier.type}\u0000${normalizedValue}`, {
      type: identifier.type,
      value: identifier.value,
      normalizedValue,
    });
  }
  return [...byKey.entries()]
    .toSorted(([left], [right]) => compareCodeUnit(left, right))
    .map(([, identifier]) => identifier);
};

const identifierKey = ({
  type,
  normalizedValue,
}: HeldDecisionDeclaredIdentifier) => `${type}\u0000${normalizedValue}`;

type PlanAttachmentOptions = AttachToHeldDecisionOptions & {
  sourceDocumentId: string;
  metadata: Readonly<Record<string, unknown>>;
  documentPart: CollectionDocumentPart | null;
};

const conflictingCandidateIds = (
  match: HostMatch,
): SafeId<"caseLawDecision">[] => {
  switch (match.type) {
    case "none":
      return [];
    case "one":
      return [match.host.id];
    case "review":
      return match.candidateDecisionIds;
    default:
      match satisfies never;
      return panic("Unhandled held host match");
  }
};

const attachmentParkReason = (match: HostMatch, ownershipConflict: boolean) => {
  if (ownershipConflict) {
    return {
      errorType: "held-identity-conflict",
      errorMessage:
        "Publisher ownership requires reconciliation with a canonical host",
    };
  }
  if (match.type === "review") {
    switch (match.evidence?.status) {
      case "ambiguous":
        return {
          errorType: "held-ambiguous",
          errorMessage:
            "Publisher identity names several possible held decisions",
        };
      case "outside-policy":
        return {
          errorType: "held-source-policy",
          errorMessage:
            "The matched publisher is outside this collection's attachment policy",
        };
      case "conflict":
      case undefined:
        break;
      default:
        match.evidence satisfies never;
        return panic("Unhandled held identity evidence");
    }
  }
  return {
    errorType: "held-identity-conflict",
    errorMessage:
      "Publisher identity does not name one consistent held decision",
  };
};

const settleAttachmentConflictTx = async (
  tx: Transaction,
  {
    options,
    owners,
    stored,
    match,
  }: {
    options: PlanAttachmentOptions;
    owners: BoundedReadResult<HostDecision>;
    stored: StoredAttachment | undefined;
    match: HostMatch;
  },
): Promise<AttachmentPlan | null> => {
  const { sourceId, observation, observationOrder, observedAt } = options;
  const previousHost =
    stored === undefined || stored.hostDecisionId === null
      ? undefined
      : await readHostTx(tx, stored.hostDecisionId);
  if (
    stored !== undefined &&
    stored.hostDecisionId !== null &&
    (previousHost === undefined || previousHost.redactedAt !== null)
  ) {
    return {
      type: "settled",
      step: settled(await parkWithdrawnTx(tx, stored, previousHost)),
    };
  }
  const ownershipConflict =
    owners.type === "overflow" ||
    owners.rows.some(
      (owner) => match.type !== "one" || match.host.id !== owner.id,
    );
  const associationConflict =
    previousHost !== undefined &&
    (match.type !== "one" || match.host.id !== previousHost.id);
  if (ownershipConflict || associationConflict || match.type === "review") {
    await clearUnbackedSourceIdentitiesTx(tx, {
      sourceId,
      sourceDocumentIds: observation.exactSourceIdentityCandidates,
    });
    const parked = await parkIngestionFailureTx(tx, {
      sourceId,
      input: observation.observed,
      observation: { order: observationOrder, observedAt },
      ...attachmentParkReason(match, ownershipConflict),
    });
    if (Result.isError(parked)) {
      return { type: "refused", error: parked.error };
    }
    // A conflicting re-observation never replaces an existing verified binding.
    if (ownershipConflict || associationConflict) {
      return {
        type: "settled",
        step: settled({
          type: "review",
          review: HELD_DECISION_REVIEW.SEVERAL_HELD,
          basis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
          candidateDecisionIds: conflictingCandidateIds(match),
        }),
      };
    }
  }
  return null;
};

/**
 * Decide, under the record's identity locks, whether it is its own decision,
 * already settled, parked, or to be attached to one host.
 */
const planAttachmentTx = async (
  tx: Transaction,
  options: PlanAttachmentOptions,
): Promise<AttachmentPlan> => {
  const {
    sourceId,
    sourceDocumentId,
    observation,
    observationOrder,
    observedAt,
    metadata,
  } = options;
  await lockSourceIdentitiesTx(
    tx,
    sourceId,
    observation.sourceIdentityCandidates,
  );
  const owners = await readPublisherOwnersTx(tx, options);
  const own =
    owners.type === "complete" && owners.rows.at(0)?.sourceId === sourceId
      ? owners.rows.at(0)
      : undefined;
  const stored = await readAttachmentTx(tx, sourceId, sourceDocumentId);
  if (stored !== undefined && stored.hostWithdrawnAt !== null) {
    return {
      type: "settled",
      step: settled(
        stored.hostDecisionId === null
          ? null
          : { type: "withdrawn", hostDecisionId: stored.hostDecisionId },
      ),
    };
  }
  if (stored !== undefined && stored.observationOrder >= observationOrder) {
    return {
      type: "settled",
      step:
        own !== undefined && stored.hostDecisionId === own.id
          ? { type: "own-row" }
          : settled({ type: "stale" }),
    };
  }
  const match = await matchHostDecisionsTx(tx, options);
  const conflict = await settleAttachmentConflictTx(tx, {
    options,
    owners,
    stored,
    match,
  });
  if (conflict !== null) {
    return conflict;
  }
  switch (match.type) {
    case "none": {
      if (stored !== undefined) {
        // A record parked as ambiguous whose candidates are gone is a
        // decision of its own now.
        // audit: skip — background case-law ingestion; public case-law data
        await tx
          .delete(caseLawHeldDecisionAttachments)
          .where(attachmentKey(sourceId, sourceDocumentId));
      }
      return { type: "settled", step: { type: "own-row" } };
    }
    case "review": {
      const parked = {
        matchBasis: match.basis,
        matchEvidence: match.evidence ?? null,
        documentPart: null,
        documentBodyS3Key: null,
        documentBodySha256: null,
        hostDecisionId: null,
        hostWithdrawnAt: null,
        candidateDecisionIds: match.candidateDecisionIds,
        metadata: { ...metadata },
        declaredIdentifiers: [],
        sourceUrl: observation.observed.sourceUrl ?? null,
        sourceHash: observation.observed.rawHash,
        sourceRawS3Key: null,
        sourceRawContentType: null,
        observedAt,
        observationOrder,
      };
      const write = replayWrite(caseLawHeldDecisionAttachments, parked, {
        modifiedAt: {
          column: caseLawHeldDecisionAttachments.updatedAt,
          value: new Date(),
        },
      });
      // audit: skip — background case-law ingestion; public case-law data
      await tx
        .insert(caseLawHeldDecisionAttachments)
        .values({ sourceId, sourceDocumentId, ...parked })
        .onConflictDoUpdate({
          target: [
            caseLawHeldDecisionAttachments.sourceId,
            caseLawHeldDecisionAttachments.sourceDocumentId,
          ],
          set: write.set,
          setWhere: write.setWhere,
        });
      logger.warn(
        match.review === HELD_DECISION_REVIEW.SEVERAL_HELD
          ? HELD_DECISION_AMBIGUOUS
          : HELD_DECISION_DOCKET_OTHER_DATE,
        {
          sourceId,
          sourceDocumentId,
          review: match.review,
          basis: match.basis,
          candidates: match.candidateDecisionIds.length,
        },
      );
      return {
        type: "settled",
        step: settled({
          type: "review",
          review: match.review,
          basis: match.basis,
          candidateDecisionIds: match.candidateDecisionIds,
        }),
      };
    }
    case "one": {
      if (match.host.redactedAt !== null) {
        // A takedown covers every publisher's copy of the decision: record
        // that this one belongs to it, and keep nothing of it.
        const withdrawn = {
          matchBasis: match.basis,
          hostDecisionId: match.host.id,
          hostWithdrawnAt: observedAt,
          candidateDecisionIds: [],
          metadata: null,
          declaredIdentifiers: [],
          sourceUrl: observation.observed.sourceUrl ?? null,
          sourceHash: observation.observed.rawHash,
          sourceRawS3Key: null,
          sourceRawContentType: null,
          observedAt,
          observationOrder,
        };
        const write = replayWrite(caseLawHeldDecisionAttachments, withdrawn, {
          modifiedAt: {
            column: caseLawHeldDecisionAttachments.updatedAt,
            value: new Date(),
          },
        });
        // audit: skip — background case-law ingestion; public case-law data
        await tx
          .insert(caseLawHeldDecisionAttachments)
          .values({ sourceId, sourceDocumentId, ...withdrawn })
          .onConflictDoUpdate({
            target: [
              caseLawHeldDecisionAttachments.sourceId,
              caseLawHeldDecisionAttachments.sourceDocumentId,
            ],
            set: write.set,
            setWhere: write.setWhere,
          });
        logger.warn(HELD_DECISION_WITHDRAWN, {
          sourceId,
          sourceDocumentId,
          hostDecisionId: match.host.id,
        });
        return {
          type: "settled",
          step: settled({ type: "withdrawn", hostDecisionId: match.host.id }),
        };
      }
      return {
        type: "attach",
        writeRoute: own?.id === match.host.id ? "own-row" : "attachment",
        host: match.host,
        basis: match.basis,
        stored,
      };
    }
    default:
      match satisfies never;
      return panic(`Unhandled host match: ${String(match)}`);
  }
};

type WriteAttachmentOptions = PlanAttachmentOptions & {
  host: HostDecision;
  basis: HeldDecisionAttachingBasis;
  /** The attachment state the plan read; a different one is contention. */
  planned: StoredAttachment | undefined;
  raw: { key: string | null; contentType: string | null };
  body: { key: string; sha256: string } | null;
  declared: HeldDecisionDeclaredIdentifier[];
};

type AttachmentWrite =
  | { type: "written" }
  | { type: "contention" }
  | { type: "too-many-identifiers" };

/**
 * Write the attachment and its declared identifiers, with the host's
 * projection, under the record's identity locks and a lock on the host
 * row: an erasure that takes the host after this commits sees the attachment
 * and parks it, and one that took it before leaves this write nothing to
 * attach to.
 */
const heldEcliDiscrepancy = (
  basis: HeldDecisionAttachingBasis,
  observation: ObservedDecision,
  host: HostDecision,
) =>
  basis === HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE &&
  observation.observed.ecli !== undefined &&
  host.ecli !== null &&
  normalizeDecisionIdentifierIn(observation.observed.country, {
    type: DECISION_IDENTIFIER_TYPES.ECLI,
    value: observation.observed.ecli,
  }) !==
    normalizeDecisionIdentifierIn(observation.observed.country, {
      type: DECISION_IDENTIFIER_TYPES.ECLI,
      value: host.ecli,
    })
    ? { sourceValue: observation.observed.ecli, hostValue: host.ecli }
    : null;

const attachmentMatchesPlan = ({
  current,
  planned,
}: {
  current: StoredAttachment | undefined;
  planned: StoredAttachment | undefined;
}) =>
  current?.observationOrder === planned?.observationOrder &&
  current?.hostDecisionId === planned?.hostDecisionId &&
  current?.sourceHash === planned?.sourceHash &&
  current?.documentBodySha256 === planned?.documentBodySha256 &&
  (current === undefined || current.hostWithdrawnAt === null);

const writeAttachmentTx = async (
  tx: CitationGraphTransaction<Transaction>,
  {
    sourceId,
    sourceDocumentId,
    declaration: optionsDeclaration,
    observation,
    observationOrder,
    observedAt,
    metadata,
    host,
    basis,
    planned,
    raw,
    body,
    documentPart,
    declared,
  }: WriteAttachmentOptions,
): Promise<AttachmentWrite> => {
  await lockSourceIdentitiesTx(
    tx,
    sourceId,
    observation.sourceIdentityCandidates,
  );
  const matched = await matchHostDecisionsTx(tx, {
    declaration: optionsDeclaration,
    observation,
    sourceId,
  });
  if (
    matched.type !== "one" ||
    matched.host.id !== host.id ||
    matched.host.sourceId !== host.sourceId ||
    matched.host.ecli !== host.ecli
  ) {
    return { type: "contention" };
  }
  // Source lock before the row lock, the order every decision writer and
  // the erasure take them in.
  const projectionLock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
    family: "case_law",
    sourceId: host.sourceId,
  });
  await lockCaseLawDecisionRows({ tx, decisionIds: [host.id] });
  const liveHost = (
    await tx
      .select({ redactedAt: caseLawDecisions.redactedAt })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, host.id))
      .limit(1)
  ).at(0);
  const current = await readAttachmentTx(tx, sourceId, sourceDocumentId);
  if (
    liveHost === undefined ||
    liveHost.redactedAt !== null ||
    !attachmentMatchesPlan({ current, planned })
  ) {
    return { type: "contention" };
  }
  const previous = current === undefined ? [] : current.declaredIdentifiers;
  const incoming = new Set(declared.map(identifierKey));
  const withdrawn = previous.filter(
    (identifier) => !incoming.has(identifierKey(identifier)),
  );
  const hostIdentifiers = await tx
    .select({
      type: caseLawDecisionIdentifiers.type,
      normalizedValue: caseLawDecisionIdentifiers.normalizedValue,
    })
    .from(caseLawDecisionIdentifiers)
    .where(eq(caseLawDecisionIdentifiers.decisionId, host.id));
  const held = new Set(
    hostIdentifiers.map((identifier) =>
      identifierKey({ ...identifier, value: "" }),
    ),
  );
  const added = declared.filter(
    (identifier) => !held.has(identifierKey(identifier)),
  );
  if (hostIdentifiers.length + added.length > DECISION_IDENTIFIER_MAX_COUNT) {
    return { type: "too-many-identifiers" };
  }

  const values = {
    matchBasis: basis,
    hostDecisionId: host.id,
    hostWithdrawnAt: null,
    candidateDecisionIds: [],
    metadata: { ...metadata },
    documentPart,
    documentBodyS3Key: body?.key ?? null,
    documentBodySha256: body?.sha256 ?? null,
    matchEvidence: {
      status: "matched",
      basis,
      ecliDiscrepancy: heldEcliDiscrepancy(basis, observation, host),
    } as const,
    declaredIdentifiers: declared,
    sourceUrl: observation.observed.sourceUrl ?? null,
    sourceHash: observation.observed.rawHash,
    sourceRawS3Key: raw.key,
    sourceRawContentType: raw.contentType,
    observedAt,
    observationOrder,
  };
  const write = replayWrite(caseLawHeldDecisionAttachments, values, {
    modifiedAt: {
      column: caseLawHeldDecisionAttachments.updatedAt,
      value: new Date(),
    },
  });
  // audit: skip — background case-law ingestion; public case-law data
  await tx
    .insert(caseLawHeldDecisionAttachments)
    .values({ sourceId, sourceDocumentId, ...values })
    .onConflictDoUpdate({
      target: [
        caseLawHeldDecisionAttachments.sourceId,
        caseLawHeldDecisionAttachments.sourceDocumentId,
      ],
      set: write.set,
      setWhere: write.setWhere,
    });

  await withdrawAttachmentIdentifiersTx(tx, {
    decisionId: host.id,
    identifiers: withdrawn,
  });
  await declareDecisionIdentifiersTx(tx, {
    decisionId: host.id,
    identifiers: declared,
    claim: { type: "attachment", observedAt },
  });
  // The search document is built from the host's identifiers.
  if (projectionLock !== null && (added.length > 0 || withdrawn.length > 0)) {
    await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
      lock: projectionLock,
      subject: { family: "case_law", entityId: host.id },
    });
  }
  await clearUnbackedSourceIdentitiesTx(tx, {
    sourceId,
    sourceDocumentIds: observation.exactSourceIdentityCandidates,
  });
  await clearIngestionFailureEvidenceTx(tx, { sourceId, sourceDocumentId });
  return { type: "written" };
};

const prepareDocumentPart = (
  declaration: HeldDecisionAttachment<string>,
  observed: ObservedDecision["observed"],
) => {
  const parsedPart =
    declaration.documentPartSchema === undefined
      ? null
      : v.safeParse(
          declaration.documentPartSchema,
          observed.metadata[declaration.metadataKey],
        );
  if (parsedPart !== null && !parsedPart.success) {
    return Result.err(
      new UnpersistableDecisionFieldError({
        message: "Collection document part does not match its source schema",
        field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
      }),
    );
  }
  const documentPart = parsedPart?.output ?? null;
  const payload = {
    text: observed.fulltext ?? null,
    sections: observed.sections ?? null,
    ast: observed.documentAst,
  };
  if (documentPart !== null) {
    const checked = validateCollectionDocumentPart(documentPart, payload);
    if (Result.isError(checked)) {
      return Result.err(
        new UnpersistableDecisionFieldError({
          message: checked.error.message,
          field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
        }),
      );
    }
  }
  const encodedBody =
    documentPart === null
      ? Result.ok(null)
      : encodeCollectionDocumentBody(payload);
  if (Result.isError(encodedBody)) {
    return Result.err(
      new UnpersistableDecisionFieldError({
        message: encodedBody.error.message,
        field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
      }),
    );
  }
  return Result.ok({ documentPart, encodedBody: encodedBody.value });
};

export type OwnCollectionPart = {
  metadata: Readonly<Record<string, unknown>>;
  documentPart: CollectionDocumentPart;
  body: { key: string; sha256: string };
};

type OwnCollectionPartStage =
  | { type: "not-declared" }
  | { type: "stored"; part: OwnCollectionPart }
  | { type: "unavailable" };

type StageOwnCollectionPartOptions = Pick<
  AttachToHeldDecisionOptions,
  | "declaration"
  | "observation"
  | "sourceId"
  | "signal"
  | "s3Policy"
  | "rawPayloadWriter"
> & {
  decisionId: SafeId<"caseLawDecision">;
  rawWindow: RawSourceWriteWindow;
  onWriteStart: () => void;
};

/** Upload before insertion; the row transaction will retain the only durable reference. */
export const stageOwnCollectionPart = async ({
  declaration,
  observation: { observed },
  sourceId,
  decisionId,
  rawWindow,
  onWriteStart,
  signal,
  s3Policy,
  rawPayloadWriter = writeOwnedRawPayload,
}: StageOwnCollectionPartOptions): Promise<
  Result<OwnCollectionPartStage, UnpersistableDecisionFieldError>
> => {
  const prepared = prepareDocumentPart(declaration, observed);
  if (Result.isError(prepared)) {
    return prepared;
  }
  const { documentPart, encodedBody } = prepared.value;
  if (documentPart === null || encodedBody === null) {
    return Result.ok({ type: "not-declared" });
  }
  const metadata = readTypedMetadata(declaration, observed);
  if (Result.isError(metadata)) {
    return metadata;
  }
  const attempted = await Result.tryPromise({
    try: async () =>
      await rawPayloadWriter({
        result: {
          ...observed,
          sourceRawBytes: encodedBody,
          sourceRawObjects: undefined,
        },
        sourceId,
        ownerId: decisionId,
        contentType: COLLECTION_DOCUMENT_BODY_CONTENT_TYPE,
        storedKey: null,
        storedContentType: null,
        window: rawWindow,
        onWriteStart,
        ...(signal === undefined ? {} : { signal }),
        ...(s3Policy === undefined ? {} : { s3Policy }),
      }),
    catch: (cause) => cause,
  });
  const stored = attempted.andThen((result) => result);
  if (Result.isError(stored)) {
    signal?.throwIfAborted();
    observeFailure(stored.error, {
      sink: heldDecisionRawWriteFailed,
      ctx: { source: sourceId, decisionId, step: "stageOwnCollectionPart" },
    });
    return Result.ok({ type: "unavailable" });
  }
  return stored.map((key) =>
    key === undefined
      ? panic("A supplied own collection body needs its immutable key")
      : {
          type: "stored",
          part: {
            documentPart,
            metadata: metadata.value,
            body: { key, sha256: sha256Hex(encodedBody) },
          },
        },
  );
};

/** A new canonical row and its self-part become visible in the same transaction. */
export const persistOwnCollectionPartTx = async (
  tx: CitationGraphTransaction<Transaction>,
  write: DecisionRowWrite,
  scopedDb: ScopedDb,
): Promise<void> => {
  const part = write.ownCollectionPart;
  if (part === undefined) {
    return;
  }
  const check =
    write.heldDecisionCheck ??
    panic("A self-part needs its source attachment declaration");
  const sourceDocumentId =
    check.observation.observed.sourceDocumentId ??
    panic("A self-part needs its publisher post identity");
  const planned = await readAttachmentTx(tx, write.sourceId, sourceDocumentId);
  const written = await writeAttachmentTx(tx, {
    declaration: check.declaration,
    observation: check.observation,
    sourceId: write.sourceId,
    scopedDb,
    observedAt: write.observedAt,
    observationOrder: write.observationOrder,
    rawWindow: write.rawWrites.window,
    sourceDocumentId,
    metadata: part.metadata,
    documentPart: part.documentPart,
    body: part.body,
    host: {
      id: write.decisionId,
      sourceId: write.sourceId,
      redactedAt: null,
      ecli: write.result.ecli ?? null,
    },
    basis:
      write.persistedDecisionDate === null ||
      write.persistedDecisionDate === undefined
        ? HELD_DECISION_MATCH_BASIS.ECLI
        : HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
    planned,
    raw: {
      key: write.rawArtifact.sourceRawS3Key,
      contentType: write.rawArtifact.sourceRawContentType,
    },
    declared: declaredIdentifiersOf(
      check.declaration,
      check.observation.observed,
    ),
  });
  if (written.type !== "written") {
    panic("A newly inserted self-part must settle under its insertion fence");
  }
};

type WriteAttachmentPayloadsOptions = {
  options: AttachToHeldDecisionOptions;
  host: HostDecision;
  stored: StoredAttachment | undefined;
  encodedBody: Uint8Array | null;
  contentType: string;
};

const writeAttachmentPayloads = async ({
  options,
  host,
  stored,
  encodedBody,
  contentType,
}: WriteAttachmentPayloadsOptions) => {
  const {
    observation: { observed },
    signal,
    s3Policy,
    rawPayloadWriter = writeOwnedRawPayload,
  } = options;
  const attempted = await Result.tryPromise({
    try: async () => {
      const raw = await rawPayloadWriter({
        ...(signal === undefined ? {} : { signal }),
        ...(s3Policy === undefined ? {} : { s3Policy }),
        result: observed,
        sourceId: host.sourceId,
        ownerId: host.id,
        contentType,
        storedKey: stored?.sourceRawS3Key ?? null,
        storedContentType: stored?.sourceRawContentType ?? null,
        window: options.rawWindow,
      });
      if (Result.isError(raw)) {
        return raw;
      }
      if (encodedBody === null) {
        return Result.ok({ rawKey: raw.value, body: null });
      }
      const body = await rawPayloadWriter({
        ...(signal === undefined ? {} : { signal }),
        ...(s3Policy === undefined ? {} : { s3Policy }),
        result: {
          ...observed,
          sourceRawBytes: encodedBody,
          sourceRawObjects: undefined,
        },
        sourceId: host.sourceId,
        ownerId: host.id,
        contentType: COLLECTION_DOCUMENT_BODY_CONTENT_TYPE,
        storedKey: stored?.documentBodyS3Key ?? null,
        storedContentType:
          stored === undefined || stored.documentBodyS3Key === null
            ? null
            : COLLECTION_DOCUMENT_BODY_CONTENT_TYPE,
        window: options.rawWindow,
      });
      return body.map((key) => ({
        rawKey: raw.value,
        body:
          key === undefined
            ? panic("A supplied collection body must have its immutable key")
            : { key, sha256: sha256Hex(encodedBody) },
      }));
    },
    catch: (cause) => cause,
  });
  return attempted.andThen((result) => result);
};

const attachmentPublisherIdentity = (
  observation: ObservedDecision,
): Result<string, UnpersistableDecisionFieldError> => {
  const { observed } = observation;
  const sourceDocumentId = observed.sourceDocumentId;
  if (sourceDocumentId === undefined || sourceDocumentId.length === 0) {
    return Result.err(
      new UnpersistableDecisionFieldError({
        message:
          "A collection post requires its stable publisher document identity",
        field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
      }),
    );
  }
  const hasTuple =
    observed.caseNumber.length > 0 &&
    observation.persistedDecisionDate !== null &&
    observation.persistedDecisionDate !== undefined;
  const hasEcli =
    heldDecisionEcliIdentity(observed.country, observed.ecli) !== null;
  if (!hasTuple && !hasEcli) {
    return Result.err(
      new UnpersistableDecisionFieldError({
        message:
          "A collection post needs a decision date or ECLI to establish its ruling identity",
        field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
      }),
    );
  }
  return Result.ok(sourceDocumentId);
};

/**
 * The write-time step of a source that declares `HeldDecisionAttachment`:
 * attach the record to the one held decision it names, park it when several
 * or a withdrawn one match, or hand it back to be written as a decision of
 * its own. Replays are a fixed point: an unchanged or older observation of
 * an attached record writes nothing.
 */
export const attachToHeldDecision = async (
  options: AttachToHeldDecisionOptions,
): Promise<
  Result<
    HeldDecisionAttachmentStep,
    UnpersistableDecisionFieldError | IngestionFailureEvidenceError
  >
> => {
  const { declaration, observation, sourceId, scopedDb, signal } = options;
  const { observed } = observation;
  const publisherIdentity = attachmentPublisherIdentity(observation);
  if (Result.isError(publisherIdentity)) {
    return publisherIdentity;
  }
  const sourceDocumentId = publisherIdentity.value;
  const metadata = readTypedMetadata(declaration, observed);
  if (Result.isError(metadata)) {
    return metadata;
  }
  const preparedPart = prepareDocumentPart(declaration, observed);
  if (Result.isError(preparedPart)) {
    return preparedPart;
  }
  const { documentPart, encodedBody } = preparedPart.value;
  const planOptions: PlanAttachmentOptions = {
    ...options,
    sourceDocumentId,
    metadata: metadata.value,
    documentPart,
  };
  const plan = await runCitationGraphTransaction(
    scopedDb,
    async (tx) => await planAttachmentTx(tx, planOptions),
  );
  if (plan.type === "refused") {
    return Result.err(plan.error);
  }
  if (plan.type === "settled") {
    return Result.ok(plan.step);
  }
  const { host, basis, stored, writeRoute } = plan;
  if (
    stored?.documentBodyS3Key !== undefined &&
    stored.documentBodyS3Key !== null &&
    !payloadCarriesDocument({
      text: observed.fulltext ?? null,
      sections: observed.sections ?? null,
      ast: observed.documentAst,
    })
  ) {
    return Result.err(
      new UnpersistableDecisionFieldError({
        message:
          "A textless collection observation cannot replace its retained document snapshot",
        field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
      }),
    );
  }
  const declared = declaredIdentifiersOf(declaration, observed);
  if (
    stored !== undefined &&
    stored.sourceHash === observed.rawHash &&
    JSON.stringify(sortDeep(stored.documentPart)) ===
      JSON.stringify(sortDeep(documentPart)) &&
    stored.documentBodySha256 ===
      (encodedBody === null ? null : sha256Hex(encodedBody)) &&
    JSON.stringify(sortDeep(stored.declaredIdentifiers)) ===
      JSON.stringify(sortDeep(declared)) &&
    JSON.stringify(sortDeep(stored.metadata)) ===
      JSON.stringify(sortDeep(metadata.value))
  ) {
    return Result.ok(
      writeRoute === "own-row"
        ? { type: "own-row" }
        : settled({ type: "unchanged", hostDecisionId: host.id }),
    );
  }

  signal?.throwIfAborted();
  const contentType = observed.sourceRawContentType ?? "text/plain";
  const raw = await writeAttachmentPayloads({
    options,
    host,
    stored,
    encodedBody,
    contentType,
  });
  if (Result.isError(raw)) {
    signal?.throwIfAborted();
    // Retryable: the record is not held yet, so the cursor holds it.
    observeFailure(raw.error, {
      sink: heldDecisionRawWriteFailed,
      ctx: {
        source: sourceId,
        decisionId: host.id,
        step: "attachToHeldDecision.rawWrite",
      },
    });
    return Result.ok(
      settled(null, {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: false,
        reason: PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE,
      }),
    );
  }
  const rawKey = raw.value.rawKey ?? null;

  signal?.throwIfAborted();
  const written = await runCitationGraphTransaction(
    scopedDb,
    async (tx) =>
      await writeAttachmentTx(tx, {
        ...planOptions,
        host,
        basis,
        planned: stored,
        raw: {
          key: rawKey,
          contentType: rawKey === null ? null : contentType,
        },
        body: raw.value.body,
        declared,
      }),
  );
  switch (written.type) {
    case "contention":
      return Result.ok(settled(null, RECONCILE_CONTENTION));
    case "too-many-identifiers":
      return Result.err(
        new UnpersistableDecisionFieldError({
          message: `Declaring these identifiers would give the held decision more than ${DECISION_IDENTIFIER_MAX_COUNT}`,
          field: UNPERSISTABLE_DECISION_FIELDS.IDENTIFIER_COUNT,
        }),
      );
    case "written":
      break;
    default:
      written satisfies never;
      return panic(`Unhandled attachment write: ${String(written)}`);
  }
  logger.info(HELD_DECISION_ATTACHED, {
    sourceId,
    sourceDocumentId,
    hostDecisionId: host.id,
    basis,
  });
  return Result.ok(
    writeRoute === "own-row"
      ? { type: "own-row" }
      : settled({ type: "attached", hostDecisionId: host.id, basis }),
  );
};
