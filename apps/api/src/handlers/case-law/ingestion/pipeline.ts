import { Result, panic } from "better-result";
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";

import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisionSourceIdentities,
  caseLawDecisions,
  caseLawIngestionFailures,
  caseLawSources,
} from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import type { CitationDecisionTypeHint } from "@/api/handlers/case-law/citation-decision-type-hint";
import {
  classifyCitation,
  proceduralKeysFromMetadata,
} from "@/api/handlers/case-law/citation-kind";
import type { ProceduralKeys } from "@/api/handlers/case-law/citation-kind";
import {
  lockCitationGraph,
  reopenCitationsForDecisionIdentifiers,
  reopenCitationsForKeys,
  reopenCitationsFrom,
  reopenCitationsResolvedTo,
  resolveCitationsForDecision,
} from "@/api/handlers/case-law/citation-resolution";
import {
  ADAPTER_TIMEOUT,
  MAX_SYNC_PAGES,
} from "@/api/handlers/case-law/consts";
import {
  CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS,
  createCaseLawDecisionSlugCandidate,
  createCaseLawDecisionSlug,
} from "@/api/handlers/case-law/decisions/slug";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  bareCitationKey,
  citationKeyOf,
  decisionIdentifiersFromMetadata,
  extractCitations,
  isSelfCitation,
  normalizeDecisionIdentifier,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { publisherCitationGap } from "@/api/handlers/case-law/ingestion/citation-recall";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { extractContext } from "@/api/handlers/case-law/polarity/context";
import { pgPayloadCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import {
  ConcurrentModificationError,
  TimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import {
  reserveCaseLawCorpusUploadIntent,
  writeReservedCaseLawCorpusUpload,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  type ActiveCorpusProjectionSourceLock,
  lockActiveCorpusProjectionSourceByIdTx,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import type {
  CorpusPayload,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";
import {
  corpusMirrorColumns,
  corpusContentHash,
  corpusPayloadDisposition,
  EMPTY_CORPUS_CONTENT_HASHES,
  storedCorpusWrite,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
  writeCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { isCaseLawJurisdiction } from "@/api/lib/legal-search/ingestion-constants";
import {
  partialObservationFromMetadata,
  sanitizeResult,
} from "@/api/lib/legal-search/ingestion-normalization";
import { storedDecisionSignal } from "@/api/lib/legal-search/parsers/validate-ast";
import {
  RAW_SOURCE_FAMILY,
  writeRawSourcePayload,
} from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayloadOptions } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";
import {
  isPgConstraintError,
  PG_ERROR,
  pgErrorFields,
} from "@/api/lib/pg-error";

export { sanitizeResult };

type DbSlot = {
  acquire: (signal?: AbortSignal) => Promise<void>;
  release: () => void;
};

type PipelineInput = {
  source: typeof caseLawSources.$inferSelect;
  sourceLease: CaseLawSourceIngestionLease;
  scopedDb: ScopedDb;
  /** Per-cycle abort signal. Fires when the adapter's time budget is exhausted. */
  signal?: AbortSignal;
  /**
   * Hard caps for bounded sample runs (staging smoke): stop after this
   * many pages / newly stored decisions without advancing the cursor
   * past unprocessed work. Dedup-skipped and failed decisions do not
   * count toward the cap, so a re-run with the same cap continues past
   * already-ingested work. Defaults to the adapter's own cycle limits.
   */
  maxPages?: number;
  maxDecisions?: number;
  /**
   * Optional concurrency limiter for DB-heavy operations.
   * When provided, the pipeline acquires a slot before
   * processing decisions (insert, index, citations) and
   * releases it before the next page fetch. This lets
   * external API fetches run in parallel across adapters
   * while capping concurrent DB pressure.
   */
  dbSlot?: DbSlot;
  corpus?: CaseLawCorpusDependencies;
};

type PipelineResult = {
  inserted: number;
  skipped: number;
  searchVectorFailures: number;
  s3UploadFailures: number;
  pagesProcessed: number;
  nextCursor: string | null;
  /** Non-null if the adapter was halted early due to repeated failures. */
  haltReason: string | null;
};

const databaseTimeoutHaltReason = (error: TimeoutError): string =>
  `Database timeout; cursor held for retry: ${error.message.slice(0, 200)}`;

/**
 * Bound the outer message and the cause separately: a wrapped driver
 * error carries the full failed query in its outer message, which would
 * otherwise consume the whole budget and truncate the cause — the part
 * that says why the write failed.
 */
export const wrappedErrorDetail = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error).slice(0, 512);
  }
  const outer = error.message.slice(0, 200);
  return error.cause instanceof Error
    ? `${outer} (cause: ${error.cause.message.slice(0, 300)})`
    : outer;
};

export const PROCESS_DECISION_STATUS = {
  COMPLETE: "complete",
  RETRYABLE: "retryable",
} as const;

export const PROCESS_DECISION_RETRY_REASON = {
  CONTENTION: "contention",
  CORPUS_WRITE: "corpus-write",
  SOURCE_RAW_WRITE: "source-raw-write",
} as const;

export type ProcessResult =
  | {
      status: typeof PROCESS_DECISION_STATUS.COMPLETE;
      inserted: boolean;
      searchVectorFailed: boolean;
    }
  | {
      status: typeof PROCESS_DECISION_STATUS.RETRYABLE;
      inserted: boolean;
      reason: (typeof PROCESS_DECISION_RETRY_REASON)[keyof typeof PROCESS_DECISION_RETRY_REASON];
    };

const CONTENTION_RECONCILIATION = {
  INITIAL: "initial",
  RETRY: "retry",
} as const;

type ContentionReconciliation =
  (typeof CONTENTION_RECONCILIATION)[keyof typeof CONTENTION_RECONCILIATION];

const DECISION_ROW_WRITE_STATUS = {
  APPLIED: "applied",
  WINNER_PENDING: "winner-pending",
  WINNER_REDACTED: "winner-redacted",
  WINNER_SETTLED: "winner-settled",
} as const;

type DecisionRowWriteStatus =
  (typeof DECISION_ROW_WRITE_STATUS)[keyof typeof DECISION_ROW_WRITE_STATUS];

/** One canonical identity plus a small, explicit set of publisher aliases. */
const MAX_SOURCE_IDENTITY_CANDIDATES = 8;

/**
 * Log event emitted when a source states a decision date the ingestion
 * boundary cannot accept — a non-calendar day or a year outside the range a
 * decision can carry. Reported at WARN: the document is still stored, with
 * no date, and the raw value is carried so the publisher's shape is
 * recoverable without re-fetching.
 */
export const DECISION_DATE_OUT_OF_BOUNDS =
  "case_law.ingestion.decision_date_out_of_bounds";

/** Enough of the rejected value to identify its shape, not a payload. */
const MAX_LOGGED_DECISION_DATE_LENGTH = 64;

export const DECISION_REFRESH = {
  /**
   * Skip a decision whose source hash and metadata are unchanged: a crawl
   * that re-reads the same document has nothing new to store.
   */
  WHEN_SOURCE_CHANGED: "when-source-changed",
  /**
   * Write the result even when the source hash is unchanged. This is what a
   * re-parse of an already-stored payload needs: the source hash covers the
   * publisher's document, not what a parser derives from it, so a parser
   * that restructures a document without changing its words leaves the hash
   * exactly where it was.
   */
  ALWAYS: "always",
} as const;

export type DecisionRefresh =
  (typeof DECISION_REFRESH)[keyof typeof DECISION_REFRESH];

type ProcessDecisionAttemptOptions = {
  input: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observedAt: Date;
  observationOrder: bigint;
  contentionReconciliation: ContentionReconciliation;
  refresh: DecisionRefresh;
  corpus: CaseLawCorpusDependencies;
};

export type CaseLawCorpusDependencies = {
  mode: CorpusStorageMode;
  write: typeof writeCorpusDocument;
};

const CASE_LAW_CORPUS_DEPENDENCIES: CaseLawCorpusDependencies = {
  mode: corpusStorageMode,
  write: writeCorpusDocument,
};

type ProcessDecisionOptions = Omit<
  ProcessDecisionAttemptOptions,
  "contentionReconciliation" | "corpus" | "refresh"
> & {
  /** Defaults to `WHEN_SOURCE_CHANGED`, which is what a crawl wants. */
  refresh?: DecisionRefresh;
  corpus?: CaseLawCorpusDependencies;
};

type SourceObservation = { order: bigint };

const storedObservationPrecedes = ({ order }: SourceObservation) =>
  or(
    isNull(caseLawDecisions.sourceObservationOrder),
    lt(caseLawDecisions.sourceObservationOrder, order),
  );

type AllocateSourceObservationOrderOptions = {
  leaseToken: SafeId<"caseLawSourceIngestionLease">;
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * Take the next observation order for a source, under the lease that owns
 * its ingestion. Exported so an operator replay orders its writes on the
 * same counter a crawl does: the row-level guards compare orders, so a
 * replay that minted its own numbering could overwrite a newer observation.
 */
export const allocateSourceObservationOrder = async ({
  leaseToken,
  scopedDb,
  sourceId,
}: AllocateSourceObservationOrderOptions): Promise<bigint> =>
  await scopedDb(async (tx) => {
    // audit: skip — background ingestion ordering state for public source data
    const allocated = (
      await tx
        .update(caseLawSources)
        .set({
          observationOrder: sql`${caseLawSources.observationOrder} + 1`,
          updatedAt: sql`${caseLawSources.updatedAt}`,
        })
        .where(
          and(
            eq(caseLawSources.id, sourceId),
            eq(caseLawSources.ingestionLeaseToken, leaseToken),
            sql`${caseLawSources.ingestionLeaseExpiresAt} > now()`,
          ),
        )
        .returning({ order: caseLawSources.observationOrder })
    ).at(0);
    if (!allocated) {
      throw new ConcurrentModificationError({
        message: "Case-law source ingestion lease was lost before ordering",
      });
    }
    return allocated.order;
  });

type UploadSourceRawOptions = Omit<
  WriteRawSourcePayloadOptions,
  "family" | "sourceId"
> & { sourceId: SafeId<"caseLawSource"> };

/**
 * Upload sourceRaw to S3 under a content-addressable key, in the case-law
 * partition. Returns the S3 object key. Failing here holds the page cursor;
 * see the caller and {@link writeRawSourcePayload} for why that is safe.
 */
const uploadSourceRaw = async (
  options: UploadSourceRawOptions,
): Promise<string> =>
  await writeRawSourcePayload({
    ...options,
    family: RAW_SOURCE_FAMILY.CASE_LAW,
  });

/**
 * Row values for one extracted citation, including what the citation is
 * doing: invoking authority, or naming the case's own procedural history.
 * Classified here rather than in the extractor because the decision needs
 * the surrounding text, which the pipeline already holds.
 */
const citationRow = (
  citingDecisionId: SafeId<"caseLawDecision">,
  citation: {
    citationText: string;
    sectionIndex: number | null;
    citedDecisionTypeHint: CitationDecisionTypeHint | null;
    identifierType: DecisionIdentifierType;
    citedCourtHint: string | null;
  },
  sections: { index: number; text: string }[],
  proceduralKeys: ProceduralKeys,
) => {
  const citationKey = citationKeyOf(citation.citationText);
  return {
    citingDecisionId,
    citationText: citation.citationText,
    citationKey,
    identifierType: citation.identifierType,
    normalizedIdentifierValue: normalizeDecisionIdentifierValue(
      citation.identifierType,
      citation.citationText,
    ),
    citedDecisionTypeHint: citation.citedDecisionTypeHint,
    citedCourtHint: citation.citedCourtHint,
    kind: classifyCitation({
      citationText: citation.citationText,
      citationKey,
      proceduralKeys,
      context: extractContext(
        sections,
        citation.citationText,
        citation.sectionIndex,
      ),
    }),
    sectionIndex: citation.sectionIndex,
  };
};

/**
 * Where this decision's canonical payload ends up.
 *
 * - `postgres-only` the row carries text/sections/AST and nothing mirrors
 *   it, so any corpus pointers left over from an earlier mode are stale.
 * - `postgres-mirrored` the row carries the payload while its durable upload
 *   intent refreshes the corpus pointers under a compare-and-set.
 * - `object-storage` uses the same pending representation, then clears the
 *   Postgres payload atomically when the durable upload settles.
 */
type CorpusWritePlan =
  | { type: "postgres-only" }
  | { type: "postgres-mirrored" }
  | { type: "object-storage" }
  | { type: "preserve-stored" };

type CorpusWritePayload = CorpusPayload & {
  documentId: SafeId<"caseLawDecision">;
  jurisdiction: string;
};

type SettleCaseLawCorpusMirrorTxOptions = {
  decisionId: SafeId<"caseLawDecision">;
  persistedSourceHash: string | null;
  observationOrder: bigint;
  mirrorCarriesDocument: boolean;
  mode: CorpusStorageMode;
  /** Null when the payload carried no document and nothing was stored. */
  written: WriteCorpusResult | null;
  tx: Transaction;
};

/**
 * Settle only the observation that owns the pending mirror.
 *
 * A missed compare-and-set is retryable, not terminal: another run may still
 * leave the durable row pending, so the caller's page cursor must stay held
 * until a replay proves the mirror settled.
 */
const settleCaseLawCorpusMirrorTx = async ({
  decisionId,
  persistedSourceHash,
  observationOrder,
  mirrorCarriesDocument,
  mode,
  tx,
  written,
}: SettleCaseLawCorpusMirrorTxOptions): Promise<boolean> => {
  // audit: skip — background corpus storage; derived state, not user actions
  const settled = await tx
    .update(caseLawDecisions)
    .set({
      // Read off the storage mode rather than off the write plan: the plan
      // is derived from the mode, and a second derivation here is a mirror
      // that can go stale.
      ...(corpusPayloadDisposition({ mode, written }) === "trim"
        ? TRIMMED_CORPUS_PAYLOAD_COLUMNS
        : {}),
      ...corpusMirrorColumns({
        status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        written,
      }),
    })
    .where(
      and(
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
      ),
    )
    .returning({ id: caseLawDecisions.id });
  return settled.length > 0;
};

/**
 * SQL for "this row holds a document", in the columns or in the corpus
 * objects its hash names. The row write below carries this in its WHERE,
 * where it is evaluated with the write and cannot go stale.
 */
const rowHoldsDocument = sql<boolean>`(
  ${pgPayloadCarriesDocument}
  or (
    ${caseLawDecisions.contentHash} is not null
    and ${notInArray(caseLawDecisions.contentHash, [...EMPTY_CORPUS_CONTENT_HASHES])}
  )
)`;

/**
 * The same question, asked ahead of the write. Answered as a boolean
 * rather than by pulling the payload across: the text can be megabytes
 * and this runs inside the crawl.
 *
 * This answer is advisory: it decides whether to spend a corpus write
 * and whether to report an empty decision, neither of which can be made
 * conditional inside the row update. The guarantee that a document is
 * not overwritten lives in that update's WHERE clause, so a backfill
 * committing between this read and the write loses nothing.
 */
const hasStoredDocument = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<boolean> => {
  const [row] = await scopedDb((tx) =>
    tx
      .select({ holdsDocument: rowHoldsDocument })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
      .limit(1),
  );

  return row?.holdsDocument === true;
};

type PendingMirrorPayload = Pick<
  CorpusWritePayload,
  "ast" | "sections" | "text"
> & {
  sourceObservationHash: string | null;
  sourceObservationOrder: bigint | null;
};

const loadPendingMirrorPayload = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<PendingMirrorPayload> => {
  const row = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        documentAst: true,
        fulltext: true,
        sections: true,
        sourceObservationHash: true,
        sourceObservationOrder: true,
      },
    }),
  );
  if (!row) {
    panic("Pending case-law corpus mirror disappeared");
  }
  return {
    ast: row.documentAst,
    sections: row.sections,
    sourceObservationHash: row.sourceObservationHash,
    sourceObservationOrder: row.sourceObservationOrder,
    text: row.fulltext,
  };
};

/**
 * Structural sections for a result: the parser's own where it recovered
 * them, otherwise derived from the flattened text. Structure-derived
 * sections win — an adapter supplies them only when its parser recovered
 * the document's own headings, which is strictly better than re-deriving
 * boundaries from flattened text.
 *
 * One definition, because the stored payload's identity depends on it: a
 * second derivation elsewhere would hash a different document than the one
 * this pipeline stores.
 */
export const decisionSections = (result: IngestionResult): DecisionSection[] =>
  result.sections ?? (result.fulltext ? segmentDecision(result.fulltext) : []);

/**
 * The canonical payload a result stores, in the shape the content hash is
 * taken over. Exported so a caller comparing a re-parse against what is
 * already stored asks the same question the corpus write does.
 */
export const caseLawCanonicalPayload = (
  result: IngestionResult,
): CorpusPayload => {
  const sections = decisionSections(result);
  return {
    ast: result.documentAst,
    sections: sections.length > 0 ? sections : null,
    text: result.fulltext ?? null,
  };
};

const planCorpusWrite = (mode: CorpusStorageMode): CorpusWritePlan => {
  switch (mode) {
    case "off":
      return { type: "postgres-only" };
    case "dual-write":
      return { type: "postgres-mirrored" };
    case "canonical":
      return { type: "object-storage" };
    default: {
      mode satisfies never;
      return panic(`Unhandled corpus storage mode: ${String(mode)}`);
    }
  }
};

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
  sourceId,
  scopedDb,
  observedAt,
  observationOrder,
  contentionReconciliation,
  refresh,
  corpus,
}: ProcessDecisionAttemptOptions): Promise<ProcessResult> => {
  const result = sanitizeResult(input);
  const rejectedDecisionDate =
    result.decisionDate === undefined ? input.decisionDate : undefined;
  if (rejectedDecisionDate !== undefined) {
    logger.warn(DECISION_DATE_OUT_OF_BOUNDS, {
      sourceId,
      caseNumber: result.caseNumber,
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
    rejectedDecisionDate === undefined ? result.decisionDate : null;
  const proposedDecisionId = createSafeId<"caseLawDecision">();
  const exactSourceIdentityCandidates = (() => {
    if (!result.sourceDocumentId) {
      return [];
    }
    const identities = [result.sourceDocumentId];
    if (result.sourceDocumentIdAliases !== undefined) {
      identities.push(...result.sourceDocumentIdAliases);
    }
    return [...new Set(identities)].sort();
  })();
  const repairSourceIdentityCandidates =
    result.sourceDocumentId &&
    result.sourceDocumentIdRepairAliases !== undefined
      ? [
          ...new Set(
            result.sourceDocumentIdRepairAliases.filter(
              (identity) => !exactSourceIdentityCandidates.includes(identity),
            ),
          ),
        ].sort()
      : [];
  const sourceIdentityCandidates = [
    ...exactSourceIdentityCandidates,
    ...repairSourceIdentityCandidates,
  ].sort();
  if (sourceIdentityCandidates.length > MAX_SOURCE_IDENTITY_CANDIDATES) {
    panic("Too many publisher identities for one decision");
  }

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
                caseNumber: result.caseNumber,
                language: result.language,
                sourceDocumentId: result.sourceDocumentId,
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
                caseNumber: result.caseNumber,
                language: result.language,
                sourceDocumentId: result.sourceDocumentId,
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
                    (identity) => identity !== result.sourceDocumentId,
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
        !result.sourceDocumentId ||
        claimedDecisionId !== undefined
          ? undefined
          : await tx.query.caseLawDecisions.findFirst({
              where: {
                sourceId: { eq: sourceId },
                caseNumber: result.caseNumber,
                language: result.language,
                sourceDocumentId: { isNull: true },
              },
              columns: identityColumns,
            });
      const ecliMatches =
        legacy !== undefined &&
        result.ecli !== undefined &&
        legacy.ecli === result.ecli;
      const legacyEcliContradicts =
        legacy !== undefined &&
        legacy.ecli !== null &&
        result.ecli !== undefined &&
        legacy.ecli !== result.ecli;
      const sourceUrlMatches =
        legacy !== undefined &&
        !legacyEcliContradicts &&
        legacy.sourceUrl !== null &&
        result.legacySourceUrls?.includes(legacy.sourceUrl) === true;
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
      result.sourceDocumentId !== undefined &&
      (existing?.sourceDocumentId === null ||
        existing?.sourceDocumentId === result.sourceDocumentId ||
        (existingIdentity !== undefined &&
          (result.sourceDocumentIdAliases?.includes(existingIdentity) ===
            true ||
            result.sourceDocumentIdRepairAliases?.includes(existingIdentity) ===
              true)));
    const persistedSourceDocumentId = incomingSupersedesExisting
      ? result.sourceDocumentId
      : (existingIdentity ?? result.sourceDocumentId);

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

    return { existing, decisionId, persistedSourceDocumentId };
  });
  const { existing, decisionId, persistedSourceDocumentId } =
    identityResolution;

  if (existing?.redactedAt) {
    return {
      status: PROCESS_DECISION_STATUS.COMPLETE,
      inserted: false,
      searchVectorFailed: false,
    };
  }

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

  // Acquire the raw-source artifact before persisting its hash. A new row
  // cannot safely advance without the artifact; an update preserves its old
  // key and carries a retryable failure through the eventual row outcome.
  const acquireSourceRawArtifact = async () => {
    const rawPayload = preservesExistingDetail
      ? undefined
      : (result.sourceRawBytes ?? result.sourceRaw);
    const rawContentType = result.sourceRawContentType ?? "text/plain";

    let sourceRawS3Key: string | null = null;
    let sourceRawContentType: string | null = null;
    let s3UploadFailed = false;
    if (preservesExistingDetail) {
      sourceRawS3Key = existing.sourceRawS3Key;
      sourceRawContentType = existing.sourceRawContentType;
    } else if (rawPayload !== undefined) {
      try {
        sourceRawS3Key = await uploadSourceRaw({
          sourceId,
          data: rawPayload,
          contentType: rawContentType,
          storedKey: existing?.sourceRawS3Key ?? null,
          storedContentType: existing?.sourceRawContentType ?? null,
        });
        sourceRawContentType = rawContentType;
      } catch (error) {
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
        sourceRawS3Key = existing.sourceRawS3Key;
        sourceRawContentType = existing.sourceRawContentType;
        s3UploadFailed = true;
      }
    }

    return {
      type: "acquired",
      artifact: { s3UploadFailed, sourceRawContentType, sourceRawS3Key },
    } as const;
  };
  const sourceRawArtifact = await acquireSourceRawArtifact();
  if (sourceRawArtifact.type === "retry") {
    return sourceRawArtifact.outcome;
  }
  const {
    sourceRawContentType,
    sourceRawS3Key,
    s3UploadFailed: rawUploadFailed,
  } = sourceRawArtifact.artifact;
  let s3UploadFailed = rawUploadFailed;

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
    const incomingCarriesDocument = Boolean(
      result.fulltext || hasUsableAst(result.documentAst),
    );
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

    const corpusPlan: CorpusWritePlan =
      preserveStoredDocument && pendingMirrorPayload === null
        ? { type: "preserve-stored" }
        : planCorpusWrite(corpus.mode);

    const postgresPayload = {
      fulltext: corpusPayload.text,
      sections: corpusPayload.sections,
      documentAst: corpusPayload.ast,
    };

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
          // Every payload column, and every pointer into object storage,
          // stays exactly as stored. Leaving them out of the update is
          // what preserves them.
          return {};
        default: {
          corpusPlan satisfies never;
          return panic(`Unhandled corpus write plan: ${String(corpusPlan)}`);
        }
      }
    })();

    const incomingCitationKey = citationKeyOf(result.caseNumber);
    return {
      citations,
      corpusPayload,
      corpusPlan,
      identifierRows,
      incomingCarriesDocument,
      incomingCitationKey,
      languageGroupKey,
      mirrorCarriesDocument,
      payloadColumns,
      pendingMirrorPayload,
      proceduralKeys,
      sections,
    };
  };
  const {
    citations,
    corpusPayload,
    corpusPlan,
    identifierRows,
    incomingCarriesDocument,
    incomingCitationKey,
    languageGroupKey,
    mirrorCarriesDocument,
    payloadColumns,
    pendingMirrorPayload,
    proceduralKeys,
    sections,
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

  /**
   * Everything about a decision the candidate join filters on, read from the
   * row this transaction is about to overwrite.
   *
   * Not from the `existing` snapshot, which was read in an earlier transaction:
   * the guarded update deliberately lets a newer observation intervene, so a
   * row that went X → Y → X would compare equal against that snapshot and
   * report no change, skipping the retraction the Y edges need. What matters is
   * the identity actually replaced.
   *
   * `FOR UPDATE`, because reading it inside this transaction is not enough on
   * its own: without the row lock another observation can still commit between
   * this read and the update, and the comparison would again be against an
   * identity this transaction did not replace. The lock holds the row until
   * commit, so what is read here is what gets overwritten.
   *
   * All three fields travel together because all three are filters: a
   * jurisdiction correction under an unchanged key invalidates exactly the
   * same edges a new case number does.
   */
  const replacedResolutionIdentity = async (
    tx: Transaction,
    id: SafeId<"caseLawDecision">,
  ): Promise<{
    citationKey: string | null;
    country: string;
    decisionDate: string | null;
    identifiers: {
      type: (typeof identifierRows)[number]["type"];
      normalizedValue: string;
    }[];
  } | null> => {
    const rows = await tx
      .select({
        citationKey: caseLawDecisions.citationKey,
        country: caseLawDecisions.country,
        decisionDate: caseLawDecisions.decisionDate,
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
      })
      .from(caseLawDecisionIdentifiers)
      .where(eq(caseLawDecisionIdentifiers.decisionId, id));
    return { ...row, identifiers };
  };

  const resolutionIdentityChanged = (previous: {
    citationKey: string | null;
    country: string;
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
      (persistedDecisionDate !== undefined &&
        previous.decisionDate !== persistedDecisionDate)
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

  const writeDecisionRow = async (
    slug?: string,
  ): Promise<DecisionRowWriteStatus> =>
    await scopedDb(async (tx) => {
      // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
      const projectionLock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
        family: "case_law",
        sourceId,
      });
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
        const replacedIdentity = preservesExistingDetail
          ? null
          : await replacedResolutionIdentity(tx, existing.id);

        const updated = await tx
          .update(caseLawDecisions)
          .set({
            ...(preservesExistingDetail
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
                  metadata: result.metadata,
                  sourceRaw: null,
                  sourceRawS3Key,
                  sourceRawContentType,
                  parserVersion: result.parserVersion ?? 0,
                  // Re-pick metadata-only changes in the corpus indexer.
                  indexedHash: null,
                }),
            ...(payloadNeedsGuard ? {} : payloadColumns),
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
            updatedAt: new Date(),
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

        if (updated.length === 0) {
          // A newer observation owns the row. Its durable mirror state
          // decides whether this page may advance: a pending winner still
          // needs the source page as its replay path.
          const winner = await tx.query.caseLawDecisions.findFirst({
            where: { id: { eq: existing.id } },
            columns: { corpusMirrorStatus: true, redactedAt: true },
          });
          if (winner?.redactedAt) {
            return DECISION_ROW_WRITE_STATUS.WINNER_REDACTED;
          }
          return winner?.corpusMirrorStatus ===
            CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
            ? DECISION_ROW_WRITE_STATUS.WINNER_PENDING
            : DECISION_ROW_WRITE_STATUS.WINNER_SETTLED;
        }

        if (payloadNeedsGuard) {
          const payloadApplied = (
            await tx
              .update(caseLawDecisions)
              .set(payloadColumns)
              .where(
                and(
                  eq(caseLawDecisions.id, existing.id),
                  isNull(caseLawDecisions.redactedAt),
                  sql`not ${rowHoldsDocument}`,
                ),
              )
              .returning({ id: caseLawDecisions.id })
          ).at(0);
          if (!payloadApplied) {
            const winner = await tx.query.caseLawDecisions.findFirst({
              where: { id: { eq: existing.id } },
              columns: { corpusMirrorStatus: true, redactedAt: true },
            });
            if (winner?.redactedAt) {
              return DECISION_ROW_WRITE_STATUS.WINNER_REDACTED;
            }
            return winner?.corpusMirrorStatus ===
              CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
              ? DECISION_ROW_WRITE_STATUS.WINNER_PENDING
              : DECISION_ROW_WRITE_STATUS.WINNER_SETTLED;
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
        }

        if (
          replacedIdentity !== null &&
          resolutionIdentityChanged(replacedIdentity)
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
            [replacedIdentity.citationKey, incomingCitationKey].filter(
              (key) => key !== null,
            ),
          );
          const affectedIdentifiers = [
            ...replacedIdentity.identifiers,
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
        await tx
          .delete(caseLawCitations)
          .where(eq(caseLawCitations.citingDecisionId, existing.id));

        if (citations.length > 0) {
          await tx
            .insert(caseLawCitations)
            .values(
              citations.map((c) =>
                citationRow(existing.id, c, sections, proceduralKeys),
              ),
            );
          await resolveCitationsForDecision(tx, existing.id);
        }

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
          metadata: result.metadata,
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

      await tx.insert(caseLawDecisionIdentifiers).values(
        identifierRows.map((identifier) => ({
          decisionId: decisionRow.id,
          ...identifier,
        })),
      );

      await announceDecisionIdentifiers(tx, decisionRow.id, identifierRows);

      if (citations.length > 0) {
        await tx
          .insert(caseLawCitations)
          .values(
            citations.map((c) =>
              citationRow(decisionRow.id, c, sections, proceduralKeys),
            ),
          );
        // Resolve what was just written, in the transaction that wrote it.
        // One indexed lookup per citation against the fetch and parse this
        // page already paid for; without it every new citation waits for the
        // standing walk to come round, and the citator trails the crawl.
        await resolveCitationsForDecision(tx, decisionRow.id);
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
      });
    }
    throw rowWrite.error;
  }

  const writeStatus = rowWrite.value;
  switch (writeStatus) {
    case DECISION_ROW_WRITE_STATUS.APPLIED:
      break;
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
    try {
      const intent = await reserveCaseLawCorpusUploadIntent({
        contentHash: corpusContentHash(corpusPayload),
        decisionId,
        jurisdiction: corpusPayload.jurisdiction,
        scopedDb,
      });
      if (intent.type === "redacted") {
        return {
          status: PROCESS_DECISION_STATUS.COMPLETE,
          inserted: false,
          searchVectorFailed: false,
        };
      }
      if (intent.type === "busy") {
        return {
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          inserted: false,
          reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
        };
      }

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
      const upload = await writeReservedCaseLawCorpusUpload({
        apply: async ({ projectionLock, tx, written }) => {
          const applied = await settleCaseLawCorpusMirrorTx({
            decisionId,
            persistedSourceHash,
            observationOrder,
            mirrorCarriesDocument,
            mode: corpus.mode,
            tx,
            written,
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
        intentId: intent.intentId,
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
        write: async ({ signal: uploadSignal }) =>
          await corpus.write(
            {
              ...corpusPayload,
              // From the pre-write snapshot: the row update above moved the
              // mirror to pending, but a settled record in that snapshot
              // still proves these content-addressed objects were confirmed,
              // so an identical payload need not re-PUT them.
              stored:
                existing === undefined ? null : storedCorpusWrite(existing),
            },
            { signal: uploadSignal },
          ),
      });
      if (upload.type === "redacted-or-missing") {
        return {
          status: PROCESS_DECISION_STATUS.COMPLETE,
          inserted: false,
          searchVectorFailed: false,
        };
      }
      if (upload.type === "intent-reclaimed" || upload.type === "superseded") {
        const winner = await scopedDb((tx) =>
          tx.query.caseLawDecisions.findFirst({
            where: { id: { eq: decisionId } },
            columns: { corpusMirrorStatus: true, redactedAt: true },
          }),
        );
        if (winner?.redactedAt || !winner) {
          return {
            status: PROCESS_DECISION_STATUS.COMPLETE,
            inserted: false,
            searchVectorFailed: false,
          };
        }
        if (
          winner.corpusMirrorStatus === CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
        ) {
          return {
            status: PROCESS_DECISION_STATUS.RETRYABLE,
            inserted: false,
            reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
          };
        }
      }
    } catch (error) {
      s3UploadFailed = true;
      // The halt reason only carries a failure count; without this line the
      // cause of a held cursor is invisible to an operator reading the log.
      logger.error("case_law.ingestion.corpus_write_failed", {
        decisionId,
        caseNumber: result.caseNumber,
        country: result.country,
        ...errorSystemFields(error),
        ...pgErrorFields(error),
        "error.detail": wrappedErrorDetail(error),
      });
      captureError(error, { decisionId, step: "processDecision.corpusWrite" });
    }
  }

  // Search indexing (tsvector) is handled by a background
  // backfill loop so the slow to_tsvector + unaccent computation
  // doesn't block cursor advancement. New decisions become
  // searchable within ~30s of insertion.

  return s3UploadFailed
    ? {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: true,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      }
    : {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: true,
        searchVectorFailed: false,
      };
};

export const processDecision = async ({
  refresh = DECISION_REFRESH.WHEN_SOURCE_CHANGED,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
  ...options
}: ProcessDecisionOptions): Promise<ProcessResult> =>
  await processDecisionAttempt({
    ...options,
    contentionReconciliation: CONTENTION_RECONCILIATION.INITIAL,
    refresh,
    corpus,
  });

/**
 * Run the ingestion pipeline for a configured source.
 *
 * Fetches pages from the source adapter, processes each
 * decision (segment, extract citations, dedup), and stores
 * results in the database.
 */
export const runIngestionPipeline = async ({
  source,
  sourceLease,
  scopedDb,
  signal,
  maxPages: maxPagesOverride,
  maxDecisions,
  dbSlot,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
}: PipelineInput): Promise<PipelineResult> => {
  const adapter = getAdapter(source.adapterKey);

  if (!adapter) {
    panic(`Unknown adapter: ${source.adapterKey}`);
  }

  let cursor = source.syncCursor;
  let inserted = 0;
  let skipped = 0;
  let searchVectorFailures = 0;
  let s3UploadFailures = 0;
  let pagesProcessed = 0;
  /** Track recent cursors to detect parking (stagnation or ping-pong). */
  const recentCursors = new Set<string | null>();
  /**
   * Consecutive decision-level failures. Reset on each success.
   * If this exceeds the threshold, the adapter is halted for
   * this cycle to avoid hammering a broken court API.
   */
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 10;
  let haltReason: string | null = null;
  let checkpointObservationOrder = source.checkpointObservationOrder;

  const maxPages = maxPagesOverride ?? adapter.maxSyncPages ?? MAX_SYNC_PAGES;

  const fetchObservedPage = async (
    fetchCursor: string | null,
    pageSignal: AbortSignal,
  ) =>
    await Result.tryPromise({
      try: async () =>
        await sourceLease.beforeRemoteEffect(async () => {
          const pageResult = await adapter.fetchPage(
            fetchCursor,
            source.config ?? {},
            pageSignal,
          );
          if (Result.isError(pageResult)) {
            return { error: pageResult.error, type: "fetch-error" } as const;
          }
          return {
            observationOrder: await allocateSourceObservationOrder({
              leaseToken: sourceLease.leaseToken,
              scopedDb,
              sourceId: source.id,
            }),
            page: pageResult.value,
            type: "fetched",
          } as const;
        }),
      catch: (cause) => cause,
    });

  const fetchNextObservedPage = async () => {
    if (signal?.aborted) {
      logger.warn("case_law.ingestion.cycle_timeout", {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
        pagesProcessed,
        inserted,
        skipped,
      });
      return { type: "halt", reason: "Cycle timeout exceeded" } as const;
    }
    const pageTimeout = adapter.pageTimeoutMs ?? ADAPTER_TIMEOUT.PAGE;
    const pageSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(pageTimeout)])
      : AbortSignal.timeout(pageTimeout);
    recentCursors.add(cursor);
    const observedPageResult = await fetchObservedPage(cursor, pageSignal);
    if (Result.isError(observedPageResult)) {
      if (observedPageResult.error instanceof TimeoutError) {
        return {
          type: "halt",
          reason: databaseTimeoutHaltReason(observedPageResult.error),
        } as const;
      }
      if (observedPageResult.error instanceof Error) {
        throw observedPageResult.error;
      }
      throw new ConcurrentModificationError({
        message: "Case-law source observation failed",
      });
    }
    if (observedPageResult.value.type === "fetch-error") {
      // Expected operational failure: record one halt in the event/log path;
      // the runner, rather than every attempt, captures sustained stalls.
      const reason = `Page fetch failed: ${observedPageResult.value.error.message}`;
      logger.error("case_law.ingestion.adapter_halted", {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
        httpStatus: String(observedPageResult.value.error.httpStatus ?? ""),
        reason,
        inserted,
        skipped,
      });
      return { type: "halt", reason } as const;
    }
    return observedPageResult.value;
  };

  /**
   * Write a page's decision failures in one insert. The handle is bound here,
   * outside the page loop, so the loop hands the whole set to a batched write
   * instead of reaching for the database once per page. Returns a halt reason
   * when the write times out: these rows are diagnostic, but a database that
   * cannot take them must not see the cursor advance.
   */
  const flushIngestionFailures = async (
    failures: readonly (typeof caseLawIngestionFailures.$inferInsert)[],
  ): Promise<string | null> => {
    try {
      await logIngestionFailures(scopedDb, failures);
      return null;
    } catch (error) {
      captureError(error, {
        sourceId: source.id,
        step: "runIngestionPipeline.logIngestionFailures",
        failureCount: String(failures.length),
      });
      return error instanceof TimeoutError
        ? databaseTimeoutHaltReason(error)
        : null;
    }
  };

  while (pagesProcessed < maxPages) {
    const observedPage = await fetchNextObservedPage();
    if (observedPage.type === "halt") {
      haltReason = observedPage.reason;
      break;
    }

    // Order the observation after the source response exists. A request-start
    // token can invert two overlapping responses and make an older payload
    // dominate a newer one. The source lease prevents those fetches from
    // overlapping; this durable token orders the resulting database writes.
    const { observationOrder, page } = observedPage;
    checkpointObservationOrder = observationOrder;
    const observedAt = new Date();

    // Acquire DB slot before processing decisions (DB-heavy:
    // insert, search index, citation extraction). Released
    // before the next page fetch so external API calls don't
    // hold the slot. try-finally ensures no slot leak on
    // unexpected exceptions.
    //
    // A page with no decisions never touches the slot: it has no DB
    // work, and acquiring anyway let a cycle-timeout abort land in
    // the gap between the fetch returning and the acquire — breaking
    // out before the cursor advance below ever ran, silently
    // discarding the forward progress the fetch had already made and
    // pinning the adapter to the same cursor on every later cycle.
    let pageHoldsDbSlot = false;
    if (dbSlot && page.decisions.length > 0) {
      try {
        await dbSlot.acquire(signal);
        pageHoldsDbSlot = true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          haltReason = "Cycle timeout exceeded";
          break;
        }
        throw error;
      }
    }
    const pageT0 = performance.now();
    const insertedBefore = inserted;
    const skippedBefore = skipped;
    const s3FailuresBefore = s3UploadFailures;
    try {
      let retryableDecision = false;
      const pageFailures: (typeof caseLawIngestionFailures.$inferInsert)[] = [];
      try {
        for (const result of page.decisions) {
          if (maxDecisions !== undefined && inserted >= maxDecisions) {
            // Halting (instead of breaking quietly) keeps the cursor at
            // this page so the unprocessed remainder is not skipped.
            haltReason = `Decision cap (${maxDecisions}) reached`;
            break;
          }
          try {
            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- per-decision ingest pipeline: identity locks, corpus write, upsert, citations, ordered per observation
            const outcome = await processDecision({
              input: result,
              sourceId: source.id,
              scopedDb,
              observedAt,
              observationOrder,
              corpus,
            });

            if (outcome.inserted) {
              inserted++;
            } else {
              skipped++;
            }
            consecutiveFailures = 0;
            switch (outcome.status) {
              case PROCESS_DECISION_STATUS.COMPLETE:
                if (outcome.searchVectorFailed) {
                  searchVectorFailures++;
                }
                break;
              case PROCESS_DECISION_STATUS.RETRYABLE:
                switch (outcome.reason) {
                  case PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE:
                    s3UploadFailures++;
                    haltReason =
                      "1 corpus write failure(s); cursor held for retry";
                    break;
                  case PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE:
                    s3UploadFailures++;
                    haltReason =
                      "1 source raw write failure(s); cursor held for retry";
                    break;
                  case PROCESS_DECISION_RETRY_REASON.CONTENTION:
                    haltReason =
                      "Concurrent decision reconciliation; cursor held for retry";
                    break;
                  default:
                    outcome.reason satisfies never;
                    return panic(`Unhandled reason: ${String(outcome.reason)}`);
                }
                retryableDecision = true;
                break;
              default:
                outcome satisfies never;
                return panic(`Unhandled outcome: ${String(outcome)}`);
            }
            if (retryableDecision) {
              break;
            }
          } catch (error) {
            consecutiveFailures++;
            const tag = errorTag(error);
            const message =
              error instanceof Error ? error.message : String(error);

            logger.error("case_law.ingestion.decision_failed", {
              adapterKey: adapter.key,
              caseNumber: result.caseNumber,
              cursor: cursor ?? "",
              ...errorSystemFields(error),
              ...pgErrorFields(error),
              // "message" is stripped by the logger sanitizer; use
              // "error.detail" so the SQL/HTTP/SDK reason reaches
              // CloudWatch. Case-law data is public, no PII concern.
              "error.detail": wrappedErrorDetail(error),
              consecutiveFailures,
            });
            captureError(error, {
              adapterKey: adapter.key,
              caseNumber: result.caseNumber,
              cursor: cursor ?? "",
            });

            if (error instanceof TimeoutError) {
              haltReason = databaseTimeoutHaltReason(error);
              break;
            }

            // Persist failure for later analysis; written once per page below.
            pageFailures.push({
              sourceId: source.id,
              caseNumber: result.caseNumber,
              language: result.language,
              errorType: tag.slice(0, 128),
              errorMessage: message.slice(0, 2048),
              cursor,
            });

            skipped++;

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              haltReason =
                `${MAX_CONSECUTIVE_FAILURES} consecutive failures; ` +
                `last: [${tag}] ${message.slice(0, 200)}`;
              break;
            }
          }
        }
      } finally {
        // Flush here, not after the loop: every mid-page exit above is a
        // `break` or a throw, and a `finally` still records what the page
        // collected. It runs before the cursor advance below, so a timeout
        // writing these rows still holds the cursor.
        //
        // Flush unconditionally. `haltReason ??= await flush(...)` would skip
        // the flush entirely once the page had halted, dropping exactly the
        // failures a halted page most needs recorded; an existing halt reason
        // still wins over the flush's own.
        const flushHaltReason = await flushIngestionFailures(pageFailures);
        haltReason ??= flushHaltReason;
      }

      const pageInserted = inserted - insertedBefore;
      const pageSkipped = skipped - skippedBefore;
      const pageS3Failures = s3UploadFailures - s3FailuresBefore;
      if (pageS3Failures > 0 && haltReason === null) {
        // Hold the cursor on a page with failed corpus writes: cursor
        // sources do not re-emit consumed pages, so advancing would leave
        // the preserved source-hash retry unreachable until the source
        // changes again.
        haltReason = `${pageS3Failures} corpus write failure(s); cursor held for retry`;
      }
      logger.info("case_law.ingestion.pipeline_page_done", {
        adapterKey: adapter.key,
        cursor: cursor ?? "",
        nextCursor: page.nextCursor ?? "",
        page: pagesProcessed + 1,
        decisions: page.decisions.length,
        inserted: pageInserted,
        skipped: pageSkipped,
        durationMs: Math.round(performance.now() - pageT0),
        halted: haltReason !== null,
      });

      if (haltReason) {
        logger.error("case_law.ingestion.adapter_halted", {
          adapterKey: adapter.key,
          cursor: cursor ?? "",
          reason: haltReason,
          inserted,
          skipped,
        });
        break;
      }

      cursor = page.nextCursor;
      pagesProcessed++;
    } finally {
      if (dbSlot && pageHoldsDbSlot) {
        dbSlot.release();
      }
    }

    // Stop when the adapter signals exhaustion: null cursor
    // or a cursor we've already visited (stagnation / ping-pong
    // between two parked positions).
    if (!page.nextCursor || recentCursors.has(page.nextCursor)) {
      break;
    }

    if (adapter.minRequestIntervalMs > 0) {
      await Bun.sleep(adapter.minRequestIntervalMs);
    }
  }

  await sourceLease.beforeDatabaseMark();
  const checkpoint = await advanceCorpusIngestionCheckpoint({
    expectedCursor: source.syncCursor,
    nextCursor: cursor,
    scopedDb,
    source: {
      id: source.id,
      leaseToken: sourceLease.leaseToken,
      observationOrder: checkpointObservationOrder,
      type: CORPUS_SOURCE_TYPE.CASE_LAW,
    },
  });
  if (checkpoint.status === INGESTION_CHECKPOINT_STATUS.MISSING) {
    return panic("Case-law ingestion source disappeared before checkpoint");
  }
  if (checkpoint.status === INGESTION_CHECKPOINT_STATUS.SUPERSEDED) {
    logger.warn("case_law.ingestion.checkpoint_superseded", {
      adapterKey: source.adapterKey,
      sourceId: source.id,
    });
  }
  cursor = checkpoint.cursor;

  return {
    inserted,
    skipped,
    searchVectorFailures,
    s3UploadFailures,
    pagesProcessed,
    nextCursor: cursor,
    haltReason,
  };
};

const logIngestionFailures = async (
  scopedDb: ScopedDb,
  failures: readonly (typeof caseLawIngestionFailures.$inferInsert)[],
) => {
  if (failures.length === 0) {
    return;
  }
  // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
    return tx.insert(caseLawIngestionFailures).values([...failures]);
  });
};
