import { Result, panic } from "better-result";
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";

import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { mapWithConcurrency } from "@stll/concurrency";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisionSourceIdentities,
  caseLawDecisionSupplements,
  caseLawDecisions,
  caseLawIngestionFailures,
  caseLawPolarityRules,
  caseLawSources,
} from "@/api/db/schema";
import { corpusStorageMode, envBase } from "@/api/env-base";
import {
  CITATION_KIND,
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
import {
  StoredRawReadError,
  withSourceRawObjects,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionSupplement,
  IngestionResult,
  SourceAdapter,
  SourceRawObjectRef,
  StoredRawResultReader,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
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
import { refreshSourceStoredTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import { absorbStandaloneSupplementRow } from "@/api/handlers/case-law/ingestion/supplement-absorption";
import {
  composeDecisionWithSupplements,
  detachSupplement,
  detachSupplementsLeftOut,
  lockSupplementTarget,
  markSupplementsMerged,
  planSupplementComposition,
  sameSupplementVersions,
  selectComposableSupplements,
  selectRulingsUnder,
  selectSupplementJudgment,
  supplementCanJoin,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import type {
  StoredSupplement,
  SupplementTargetKey,
} from "@/api/handlers/case-law/ingestion/supplement-composition";
import { replaceDecisionJudges } from "@/api/handlers/case-law/judges/decision-judges";
import { extractContexts } from "@/api/handlers/case-law/polarity/context";
import {
  ACTIVE_RULE_SOURCES,
  loadRules,
  selectCitationPolarity,
} from "@/api/handlers/case-law/polarity/rule-engine";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import {
  corpusCarriesDocument,
  pgPayloadCarriesDocument,
} from "@/api/handlers/case-law/stored-payload";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { preserveStoredTextAfterParseFailure } from "@/api/lib/case-law/decision-text";
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
import { settleReservedCaseLawCorpusUpload } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import {
  enqueueCaseLawRawSweepTx,
  rawSweepSettleAfter,
} from "@/api/lib/legal-search/case-law-raw-sweeps";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  type ActiveCorpusProjectionSourceLock,
  lockActiveCorpusProjectionSourceByIdTx,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  deployedCorpusTransfer,
  openCorpusPackBatch,
} from "@/api/lib/legal-search/corpus-pack-batch";
import type {
  CorpusPackBatch,
  CorpusPackBatchOutcome,
  CorpusTransfer,
} from "@/api/lib/legal-search/corpus-pack-batch";
import type {
  CorpusPayload,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";
import {
  corpusMirrorColumns,
  corpusPayloadDisposition,
  EMPTY_CORPUS_CONTENT_HASHES,
  storedCorpusWrite,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";
import {
  type StartCycleDeadlineOptions,
  canStartCyclePage,
  remainingCycleMs,
  startCycleDeadline,
} from "@/api/lib/legal-search/cycle-deadline";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
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
import {
  copyRawObject,
  homeRawPayloadObjects,
  openRawSourceWriteWindow,
  RAW_SOURCE_FAMILY,
  rawSourcePayloadKey,
  sourceBinaryRef,
  writeCaseLawRawPayload,
  writeSourceBinary,
} from "@/api/lib/legal-search/raw-source-storage";
import type {
  RawSourceWriteFailure,
  WriteRawSourcePayload,
  WriteRawSourcePayloadOptions,
} from "@/api/lib/legal-search/raw-source-storage";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  isPgConstraintError,
  PG_ERROR,
  pgErrorFields,
} from "@/api/lib/pg-error";
import {
  isMissingS3ObjectError,
  readS3ObjectBounded,
  S3ObjectBudgetError,
} from "@/api/lib/s3";
import { isRecord } from "@/api/lib/type-guards";

export { sanitizeResult };

type DbSlot = {
  acquire: (signal?: AbortSignal) => Promise<void>;
  release: () => void;
};

type PipelineInput = {
  source: typeof caseLawSources.$inferSelect;
  sourceLease: CaseLawSourceIngestionLease;
  scopedDb: ScopedDb;
  /**
   * The cycle's time budget, and the signals that end it early. The loop
   * starts a page only while enough of the budget is left for the page to
   * finish, and stops when it is exhausted. Absent in tests and bounded
   * sample runs, which stop on their own page and decision caps.
   */
  cycle?: StartCycleDeadlineOptions;
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

/**
 * Halt reasons the operator loop classifies on. The runner reads the timeout
 * one to separate a cycle that ran out of budget from one that failed, so the
 * text is a shared constant rather than a literal on both sides.
 */
export const CYCLE_HALT_REASON = {
  TIMEOUT: "Cycle timeout exceeded",
} as const;

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

/** Why a supplement's placement is retried beyond its writes' own reasons. */
export const SUPPLEMENT_RETRY_REASON = {
  /** Its standalone row still stands beside its judgment. */
  ABSORB: "supplement-absorb",
  /** Its judgment's stored payload could not be read this time. */
  JUDGMENT_READ: "supplement-judgment-read",
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
  /** The docket's supplements changed after this write composed them. */
  SUPPLEMENTS_MOVED: "supplements-moved",
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
  judges: CaseLawJudgeDependencies;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observedAt: Date;
  observationOrder: bigint;
  contentionReconciliation: ContentionReconciliation;
  refresh: DecisionRefresh;
  corpus: CaseLawCorpusDependencies;
  /**
   * The batch this decision's payloads join. A caller processing a page
   * passes one batch for the page and flushes it when the page is done; a
   * caller with a single decision omits it and the decision is flushed as a
   * batch of its own.
   */
  corpusBatch?: CorpusPackBatch | undefined;
  /**
   * Compiled polarity rules, reused across the decisions of one run. Omitted,
   * each decision reads the rules for its own language once; a crawl passes
   * one cache so the whole cycle reads them once per language.
   */
  polarityRules?: RuleCache | undefined;
};

export type CaseLawCorpusDependencies = {
  mode: CorpusStorageMode;
  /**
   * How a batch's payloads reach object storage; replaced in tests. The
   * layout and its client travel together, so a test cannot replace a client
   * the configured layout never calls.
   */
  transfer: CorpusTransfer;
};

const CASE_LAW_CORPUS_DEPENDENCIES: CaseLawCorpusDependencies = {
  mode: corpusStorageMode,
  transfer: deployedCorpusTransfer(),
};

type CorpusOutcomeContext = {
  decisionId: SafeId<"caseLawDecision">;
  /** Present where the caller still holds the adapter's own result. */
  caseNumber?: string;
  country?: string;
};

/**
 * What one decision's share of a pack write means for its own processing.
 *
 * A decision that lost its reservation or its row CAS holds the cursor: the
 * page is retried and the decision joins the next batch's pack. A failed
 * pack write holds it too, and is logged here because the halt reason
 * carries only a count.
 */
const processResultForCorpusOutcome = (
  outcome: CorpusPackBatchOutcome | undefined,
  { decisionId, caseNumber, country }: CorpusOutcomeContext,
): ProcessResult => {
  switch (outcome?.type) {
    case undefined:
    case "settled":
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: true,
        searchVectorFailed: false,
      };
    case "redacted-or-missing":
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        inserted: false,
        searchVectorFailed: false,
      };
    case "busy":
    case "retry":
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: false,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      };
    case "failed": {
      logger.error("case_law.ingestion.corpus_write_failed", {
        decisionId,
        caseNumber: caseNumber ?? "",
        country: country ?? "",
        ...errorSystemFields(outcome.error),
        ...pgErrorFields(outcome.error),
        "error.detail": wrappedErrorDetail(outcome.error),
      });
      captureError(outcome.error, {
        decisionId,
        step: "processDecision.corpusWrite",
      });
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        inserted: true,
        reason: PROCESS_DECISION_RETRY_REASON.CORPUS_WRITE,
      };
    }
    default:
      outcome satisfies never;
      return panic(`Unhandled corpus batch outcome: ${String(outcome)}`);
  }
};

/**
 * Where a decision's judges are written. Injected the way the corpus write
 * is, so the ordering against the row write can be exercised without the
 * tables behind it.
 */
export type CaseLawJudgeDependencies = {
  replace: typeof replaceDecisionJudges;
};

const CASE_LAW_JUDGE_DEPENDENCIES: CaseLawJudgeDependencies = {
  replace: replaceDecisionJudges,
};

type ProcessDecisionOptions = Omit<
  ProcessDecisionAttemptOptions,
  "contentionReconciliation" | "corpus" | "judges" | "refresh"
> & {
  /** Defaults to `WHEN_SOURCE_CHANGED`, which is what a crawl wants. */
  refresh?: DecisionRefresh;
  corpus?: CaseLawCorpusDependencies;
  judges?: CaseLawJudgeDependencies;
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

/** Wall-clock bound on copying one file an envelope names into its decision. */
const RAW_OBJECT_COPY_TIMEOUT_MS = 60_000;

type PlanSourceRawPayloadOptions = {
  result: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
};

/** The raw payload a row stores, and the publisher files it names. */
type SourceRawPayloadPlan = {
  payload: Uint8Array | string;
  /** Only the files the payload names: anything else would be unreachable. */
  files: readonly {
    bytes: Uint8Array;
    contentType: string;
    ref: SourceRawObjectRef;
  }[];
};

/**
 * The raw payload this row stores, with its binary parts resolved to the
 * addresses they are (or will be) stored at. Pure: the addresses are derived
 * from the decision and the bytes, so whether anything needs writing can be
 * decided before any write.
 *
 * An adapter that hands over bytes without an envelope still has them
 * stored as the payload itself, which is the shape every adapter wrote
 * before parts existed and the one `LEGACY_RAW_SHAPES` describes.
 */
const planSourceRawPayload = ({
  result,
  sourceId,
  decisionId,
}: PlanSourceRawPayloadOptions): SourceRawPayloadPlan | undefined => {
  if (result.sourceRawBytes !== undefined) {
    return { payload: result.sourceRawBytes, files: [] };
  }
  if (result.sourceRaw === undefined) {
    return undefined;
  }
  const files = Object.entries(result.sourceRawObjects ?? {}).map(
    ([part, { bytes, contentType }]) => ({
      part,
      bytes,
      contentType,
      ref: sourceBinaryRef({
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId,
        documentId: decisionId,
        bytes,
        contentType,
      }),
    }),
  );
  const payload =
    files.length === 0
      ? result.sourceRaw
      : withSourceRawObjects(
          result.sourceRaw,
          Object.fromEntries(files.map(({ part, ref }) => [part, ref])),
        );
  // A payload that is not an envelope cannot name the files, and a file
  // nothing names is one no reader would ever look for.
  if (files.length > 0 && payload === result.sourceRaw) {
    logger.error("case_law.ingestion.source_files_without_envelope", {
      sourceId,
      caseNumber: result.caseNumber,
      files: files.length,
    });
    return { payload, files: [] };
  }
  return { payload, files };
};

type BuildCitationRowsOptions = {
  citations: readonly ReturnType<typeof extractCitations>[number][];
  citingDecisionId: SafeId<"caseLawDecision">;
  /** The citing decision's language; it chooses the polarity rule set. */
  language: string;
  polarityRules: RuleCache | undefined;
  proceduralKeys: ProceduralKeys;
  scopedDb: ScopedDb;
  sections: { index: number; text: string }[];
};

/**
 * Every citation row for one decision: what the citation is doing (invoking
 * authority, or naming the case's own procedural history) and, where it
 * invokes one, how the citing court treats it.
 *
 * Both are read off the surrounding text, which only the pipeline holds, and
 * both are written when the row is published. Polarity used to be left to the
 * background classifier, which the refresh path then undid: refreshing a
 * decision deletes its citation rows and re-inserts them, so a label written
 * after the insert survived only until the next refresh.
 *
 * Regex tier only. A procedural citation is skipped, and so is a context no
 * rule reads: `polarity` stays null, which is what the background queue
 * selects on and what an unexamined row looks like. There is no "examined,
 * matched nothing" value, and inventing one here would empty that queue
 * without classifying anything.
 *
 * Every mention of the cited decision is read, not the first: see
 * `selectCitationPolarity` for how the readings become one label.
 *
 * Cost: one rules read per language per pipeline run where the caller owns a
 * cache, one per decision otherwise, and none at all for a decision that
 * cites nothing. Never one per citation.
 */
const buildCitationRows = async ({
  citations,
  citingDecisionId,
  language,
  polarityRules,
  proceduralKeys,
  scopedDb,
  sections,
}: BuildCitationRowsOptions): Promise<
  (typeof caseLawCitations.$inferInsert)[]
> => {
  if (citations.length === 0) {
    return [];
  }
  const rules = await loadRules(language, scopedDb, polarityRules);
  return citations.map((citation) => {
    const citationKey = citationKeyOf(citation.citationText);
    const windows = extractContexts(
      sections,
      citation.citationText,
      citation.sectionIndex,
    );
    const kind = classifyCitation({
      citationText: citation.citationText,
      citationKey,
      proceduralKeys,
      context: windows?.contexts[0] ?? null,
    });
    const match =
      kind === CITATION_KIND.PRECEDENT && windows !== null
        ? selectCitationPolarity(rules, windows.mentions)
        : null;
    return {
      citingDecisionId,
      citationText: citation.citationText,
      citationKey,
      identifierType: citation.identifierType,
      normalizedIdentifierValue: normalizeDecisionIdentifierValue(
        citation.identifierType,
        citation.identifierValue,
      ),
      citedDecisionTypeHint: citation.citedDecisionTypeHint,
      citedCourtHint: citation.citedCourtHint,
      citedSheetNumber: citation.citedSheetNumber,
      citedDecisionDate: citation.citedDecisionDate,
      kind,
      sectionIndex: citation.sectionIndex,
      polarity: match?.polarity ?? null,
      polarityRuleId: match?.ruleId ?? null,
    };
  });
};

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

/** Each rule that labelled one of these citations, and how many it labelled. */
const polarityMatchesByRule = (
  rows: readonly (typeof caseLawCitations.$inferInsert)[],
): Map<string, number> => {
  const matches = new Map<string, number>();
  for (const { polarityRuleId } of rows) {
    if (polarityRuleId) {
      matches.set(polarityRuleId, (matches.get(polarityRuleId) ?? 0) + 1);
    }
  }
  return matches;
};

/**
 * Settle this decision's polarity verdicts against the rules as they stand
 * now, and count the matches against those rules.
 *
 * The compiled rules a verdict came from were read before this transaction
 * opened, and a cache holds them for the rest of the crawl cycle. Meanwhile
 * `seed-polarity-rules.ts` retires a rule and returns every citation it
 * labelled to the unclassified pool; the maintenance lane serializes operator
 * passes against each other, not against a crawl in flight. A verdict from a
 * rule retired in that window would be published after the sweep that was
 * meant to erase it, and nothing would ever revisit it: the drain and
 * `classify-citations.ts` both select on `polarity IS NULL`. So the writer
 * asks, inside the transaction that publishes the rows, whether the rule is
 * still one the loader would compile, and drops the verdict when it is not.
 *
 * The statement is an UPDATE rather than a read, which is what orders the two
 * passes: it takes a row lock on each rule it confirms, so a retirement
 * racing this decision waits for the commit and its sweep then sees the rows.
 * The rule ids are sorted so two ingest transactions confirming the same
 * rules walk them in one order.
 *
 * Counting rides along because the count has to happen somewhere: a row
 * published with a verdict never reaches `classify-citations.ts`, which is
 * what used to move `match_count`, so without this the column would stop
 * reporting how much work a rule does — the one thing it is for.
 */
const settleCitationPolarity = async (
  tx: Transaction,
  rows: readonly (typeof caseLawCitations.$inferInsert)[],
  observedAt: Date,
): Promise<(typeof caseLawCitations.$inferInsert)[]> => {
  const matches = polarityMatchesByRule(rows);
  if (matches.size === 0) {
    return [...rows];
  }
  const tally = [...matches].toSorted(([a], [b]) => (a < b ? -1 : 1));
  const confirmed: unknown = await tx.execute(sql`
    UPDATE ${caseLawPolarityRules} AS r
       SET match_count = r.match_count + m.matches,
           updated_at = GREATEST(r.updated_at, ${observedAt})
      FROM (VALUES ${sql.join(
        tally.map(([ruleId, count]) => sql`(${ruleId}::uuid, ${count}::int)`),
        sql.raw(","),
      )}) AS m(id, matches)
     WHERE r.id = m.id
       AND r.source IN (${sql.join(
         ACTIVE_RULE_SOURCES.map((source) => sql`${source}`),
         sql.raw(","),
       )})
    RETURNING r.id::text AS id
  `);
  const active = new Set(
    executedRows(confirmed).flatMap((row) =>
      isRecord(row) && typeof row["id"] === "string" ? [row["id"]] : [],
    ),
  );
  return rows.map((row) =>
    row.polarityRuleId && !active.has(row.polarityRuleId)
      ? { ...row, polarity: null, polarityRuleId: null }
      : row,
  );
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

type AbsorbComposedSupplementRowsOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  judgmentId: SafeId<"caseLawDecision">;
  supplements: readonly Pick<StoredSupplement, "kind" | "sourceDocumentId">[];
  /** Test seam; production absorbs through the corpus stores. */
  absorb?: typeof absorbStandaloneSupplementRow;
};

type AbsorbComposedSupplementRowsOutcome =
  | { type: "absorbed" }
  /** Rows still standing beside the judgment; see the function comment. */
  | { type: "incomplete"; sourceDocumentIds: string[] };

/**
 * Take the standalone rows of supplements this judgment now holds out of the
 * corpus. Runs after the judgment's write committed, since the withdrawal
 * reaches object storage. A row that stays standing is reported, not thrown:
 * the judgment is already right. The caller decides whether to hold its
 * cursor; either way the reconciliation reads a merged supplement whose row
 * still stands as not held, so it is listed and placed again.
 */
const absorbComposedSupplementRows = async ({
  scopedDb,
  sourceId,
  judgmentId,
  supplements,
  absorb = absorbStandaloneSupplementRow,
}: AbsorbComposedSupplementRowsOptions): Promise<AbsorbComposedSupplementRowsOutcome> => {
  // One at a time: each absorption takes the citation graph lock.
  const standing = await mapWithConcurrency({
    items: supplements,
    limit: 1,
    operation: async ({ kind, sourceDocumentId }) => {
      const absorbed = await absorb({
        scopedDb,
        sourceId,
        kind,
        sourceDocumentId,
        judgmentId,
      });
      if (Result.isError(absorbed)) {
        logger.error(SUPPLEMENT_ABSORB_FAILED, {
          sourceId,
          judgmentId,
          sourceDocumentId,
          ...errorSystemFields(absorbed.error),
          "error.detail": wrappedErrorDetail(absorbed.error),
        });
        captureError(absorbed.error, {
          sourceId,
          step: "absorbComposedSupplementRows",
        });
        return [sourceDocumentId];
      }
      if (absorbed.value.type === "withdraw-incomplete") {
        logger.error(SUPPLEMENT_ABSORB_FAILED, {
          sourceId,
          judgmentId,
          sourceDocumentId,
          "error.detail":
            "a corpus object still holds the standalone row's document",
        });
        return [sourceDocumentId];
      }
      return [];
    },
  });
  const sourceDocumentIds = standing.flat();
  return sourceDocumentIds.length === 0
    ? { type: "absorbed" }
    : { type: "incomplete", sourceDocumentIds };
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
      const ecliMatches =
        legacy !== undefined &&
        observed.ecli !== undefined &&
        legacy.ecli === observed.ecli;
      const legacyEcliContradicts =
        legacy !== undefined &&
        legacy.ecli !== null &&
        observed.ecli !== undefined &&
        legacy.ecli !== observed.ecli;
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
    > => {
      const plan = planSourceRawPayload({ result, sourceId, decisionId });
      if (plan === undefined) {
        return Result.ok(undefined);
      }
      const owner = {
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId,
        documentId: decisionId,
      } as const;
      // A payload read back from storage (a replay) names files where they
      // were stored before; those are copied under this decision, so its
      // erasure reaches them and no other decision's can.
      const homed = homeRawPayloadObjects({ payload: plan.payload, owner });
      if (Result.isError(homed)) {
        return homed;
      }
      // The publisher's files first: the envelope names them, so it is
      // never stored before they are. That order is also why a row that
      // already records this exact envelope proves its files are stored,
      // and an unchanged observation writes nothing at all.
      const payloadAlreadyStored =
        storedRawKey ===
          rawSourcePayloadKey({ owner, data: homed.value.payload }) &&
        storedRawContentType === rawContentType;
      if (!payloadAlreadyStored) {
        rawWriteAttempted = true;
        for (const { bytes, contentType } of plan.files) {
          const file = await writeSourceBinary({
            ...owner,
            bytes,
            contentType,
            window: rawWriteWindow,
          });
          if (Result.isError(file)) {
            return file;
          }
        }
        for (const copy of homed.value.copies) {
          const copied = await copyRawObject({
            copy,
            window: rawWriteWindow,
            signal: AbortSignal.timeout(RAW_OBJECT_COPY_TIMEOUT_MS),
          });
          if (Result.isError(copied)) {
            return copied;
          }
        }
      }
      // Failing here holds the page cursor; see `rawWriteFailed` and
      // `writeRawSourcePayload` for why that is safe.
      return await writeCaseLawRawPayload({
        owner,
        window: rawWriteWindow,
        data: homed.value.payload,
        contentType: rawContentType,
        storedKey: storedRawKey,
        storedContentType: storedRawContentType,
      });
    };

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
    decisionDate: string | null;
    metadata: Record<string, unknown> | null;
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
                  metadata: preserveStoredTextAfterParseFailure({
                    incomingMetadata: result.metadata,
                    storedMetadata: replacedState?.metadata ?? null,
                    textFields: result.textFields,
                  }),
                  sourceRaw: null,
                  // A failed upload writes no pointer at all: the one this
                  // attempt read may since have been moved, and writing it
                  // back would point the row at an object nothing else
                  // accounts for any more.
                  ...(s3UploadFailed
                    ? {}
                    : { sourceRawS3Key, sourceRawContentType }),
                  parserVersion: result.parserVersion ?? 0,
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
          const winner = await tx.query.caseLawDecisions.findFirst({
            where: { id: { eq: existing.id } },
            columns: { corpusMirrorStatus: true, redactedAt: true },
          });
          if (winner?.redactedAt) {
            await sweepRawWriteLostToErasureTx(tx, existing.id);
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
              .set({
                ...payloadColumns,
                // Decided with the write: the marker says the row holds no
                // document, and this WHERE is the only place that is known.
                ...(storesUnpublishedWithoutDocument
                  ? {
                      metadata: metadataMarkedListingOnly(
                        caseLawDecisions.metadata,
                      ),
                    }
                  : {}),
              })
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
              await sweepRawWriteLostToErasureTx(tx, existing.id);
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
        await tx
          .delete(caseLawCitations)
          .where(eq(caseLawCitations.citingDecisionId, existing.id));

        if (citationRows.length > 0) {
          await tx
            .insert(caseLawCitations)
            .values(await settleCitationPolarity(tx, citationRows, observedAt));
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
        await tx
          .insert(caseLawCitations)
          .values(await settleCitationPolarity(tx, citationRows, observedAt));
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

/** Emitted when a supplement's standalone row could not be absorbed. */
export const SUPPLEMENT_ABSORB_FAILED =
  "case_law.ingestion.supplement_absorb_failed";

/** Emitted when a supplement's judgment could not be rebuilt to compose it. */
export const SUPPLEMENT_JUDGMENT_UNREADABLE =
  "case_law.ingestion.supplement_judgment_unreadable";

/** Emitted when a supplement's judgment payload could not be read this time. */
export const SUPPLEMENT_JUDGMENT_READ_FAILED =
  "case_law.ingestion.supplement_judgment_read_failed";

/** Why a supplement is kept as a decision of its own. */
export const SUPPLEMENT_STANDALONE_REASON = {
  /** No stored ruling under its docket can be its judgment. */
  NO_JUDGMENT: "no-judgment",
  /** Several stored rulings could be; attaching to one would be a guess. */
  AMBIGUOUS: "ambiguous",
  /** The judgment's stored payload could not be rebuilt to compose it. */
  JUDGMENT_UNREADABLE: "judgment-unreadable",
  /** The judgment holds no document of its own to compose it into yet. */
  JUDGMENT_WITHOUT_DOCUMENT: "judgment-without-document",
} as const;

export type SupplementStandaloneReason =
  (typeof SUPPLEMENT_STANDALONE_REASON)[keyof typeof SUPPLEMENT_STANDALONE_REASON];

/** What became of one supplement. */
export type SupplementDisposition =
  /** Its judgment's stored document holds this version of it. */
  | { type: "merged"; judgmentId: SafeId<"caseLawDecision"> }
  /**
   * Parked, and kept readable as a decision of its own until its judgment
   * arrives: that judgment's write composes it and absorbs the row.
   */
  | { type: "standalone"; reason: SupplementStandaloneReason }
  /**
   * Its judgment is redacted. A takedown covers the reasons of the decision
   * it took down, so the supplement is parked, nothing is published, and a
   * standalone row it already has is absorbed into the judgment.
   */
  | { type: "withheld"; judgmentId: SafeId<"caseLawDecision"> };

export type ProcessSupplementResult =
  | {
      status: typeof PROCESS_DECISION_STATUS.COMPLETE;
      disposition: SupplementDisposition;
    }
  | {
      status: typeof PROCESS_DECISION_STATUS.RETRYABLE;
      reason:
        | (typeof PROCESS_DECISION_RETRY_REASON)[keyof typeof PROCESS_DECISION_RETRY_REASON]
        | (typeof SUPPLEMENT_RETRY_REASON)[keyof typeof SUPPLEMENT_RETRY_REASON];
    };

export type ProcessSupplementOptions = {
  supplement: DecisionSupplement;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observedAt: Date;
  /**
   * The next observation order on the source's counter, under the lease the
   * caller holds. A supplement writes its judgment again, and possibly in the
   * page that just wrote it, so it cannot reuse the page's order: the row
   * guard would read the rewrite as stale.
   */
  nextObservationOrder: () => Promise<bigint>;
  /** Rebuilds the judgment from its stored payload: the adapter's replay. */
  reparseStoredRaw: NonNullable<SourceAdapter["reparseStoredRaw"]>;
  readStoredRaw: StoredRawResultReader;
  corpus?: CaseLawCorpusDependencies;
  polarityRules?: RuleCache | undefined;
  /** Test seam; production writes the object store. */
  writeRaw?: WriteRawSourcePayload;
  /** Test seam; production absorbs through the corpus stores. */
  absorb?: typeof absorbStandaloneSupplementRow;
};

type SupplementJudgmentRow = {
  id: SafeId<"caseLawDecision">;
  redacted: boolean;
};

/**
 * Store one supplement and put it where it belongs: inside its judgment's
 * document when a stored ruling is its judgment, otherwise as a decision of
 * its own until one is.
 *
 * The judgment is composed by writing it again from its own stored payload,
 * through `processDecision`: that write reads the supplement back, composes
 * it, re-extracts the citations over the whole document, and records the
 * merge in its own transaction. Replay-safe by construction: a supplement
 * whose current version its judgment already holds is a fixed point, and a
 * failure anywhere leaves it parked for the next observation of either
 * document.
 */
export const processSupplement = async ({
  supplement,
  sourceId,
  scopedDb,
  observedAt,
  nextObservationOrder,
  reparseStoredRaw,
  readStoredRaw,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
  polarityRules,
  writeRaw = writeRawSourcePayload,
  absorb = absorbStandaloneSupplementRow,
}: ProcessSupplementOptions): Promise<ProcessSupplementResult> => {
  const { sourceDocumentId } = supplement.document;
  const document = sanitizeResult(supplement.document);
  const key: SupplementTargetKey = {
    sourceId,
    court: document.court,
    caseNumber: document.caseNumber,
    language: document.language,
  };

  const stored = (
    await scopedDb((tx) =>
      tx
        .select({
          sourceHash: caseLawDecisionSupplements.sourceHash,
          sourceRawS3Key: caseLawDecisionSupplements.sourceRawS3Key,
          sourceRawContentType: caseLawDecisionSupplements.sourceRawContentType,
        })
        .from(caseLawDecisionSupplements)
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
          ),
        )
        .limit(1),
    )
  ).at(0);

  // The publisher's response is archived before the row names it, as a
  // decision's is: a row pointing at nothing could never be replayed.
  const rawPayload = document.sourceRawBytes ?? document.sourceRaw;
  const rawContentType = document.sourceRawContentType ?? "text/plain";
  let sourceRawS3Key = stored?.sourceRawS3Key ?? null;
  let sourceRawContentType = stored?.sourceRawContentType ?? null;
  if (rawPayload !== undefined) {
    const written = await Result.tryPromise({
      try: async () =>
        await writeRaw({
          family: RAW_SOURCE_FAMILY.CASE_LAW,
          sourceId,
          data: rawPayload,
          contentType: rawContentType,
          storedKey: sourceRawS3Key,
          storedContentType: sourceRawContentType,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(written)) {
      logger.error("case_law.ingestion.source_raw_write_failed", {
        sourceId,
        caseNumber: document.caseNumber,
        ...errorSystemFields(written.error),
        "error.detail": wrappedErrorDetail(written.error),
      });
      captureError(written.error, { sourceId, step: "processSupplement.raw" });
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        reason: PROCESS_DECISION_RETRY_REASON.SOURCE_RAW_WRITE,
      };
    }
    sourceRawS3Key = written.value;
    sourceRawContentType = rawContentType;
  }

  const content = {
    kind: supplement.kind,
    caseNumber: document.caseNumber,
    court: document.court,
    language: document.language,
    latestDecisionDate: supplement.target.latestDecisionDate ?? null,
    judgmentDecisionTypes: [...supplement.target.decisionTypes],
    fulltext: document.fulltext ?? null,
    documentAst: document.documentAst,
    sourceHash: document.rawHash,
    sourceUrl: document.sourceUrl ?? null,
    documentUrl: document.documentUrl ?? null,
    metadata: document.metadata,
    sourceRawS3Key,
    sourceRawContentType,
  };
  const placed = await scopedDb(async (tx) => {
    await lockSupplementTarget(tx, key);
    // audit: skip — background case-law ingestion; public case-law data
    const [row] = await tx
      .insert(caseLawDecisionSupplements)
      .values({ sourceId, sourceDocumentId, observedAt, ...content })
      .onConflictDoUpdate({
        target: [
          caseLawDecisionSupplements.sourceId,
          caseLawDecisionSupplements.sourceDocumentId,
        ],
        set: { ...content, observedAt, updatedAt: new Date() },
      })
      .returning({
        decisionId: caseLawDecisionSupplements.decisionId,
        mergedSourceHash: caseLawDecisionSupplements.mergedSourceHash,
        sourceHash: caseLawDecisionSupplements.sourceHash,
      });
    if (row === undefined) {
      return panic("Supplement upsert returned no row");
    }
    const rulings = await selectRulingsUnder(tx, {
      key,
      decisionTypes: supplement.target.decisionTypes,
    });
    const selection = selectSupplementJudgment({
      target: supplement.target,
      candidates: rulings,
    });
    return { row, rulings, selection };
  });
  const { row, rulings, selection } = placed;

  /** Object storage did not answer for the judgment: try the placement again. */
  const judgmentReadFailed = (
    judgmentId: SafeId<"caseLawDecision">,
    error: StoredRawReadError,
  ): ProcessSupplementResult => {
    logger.warn(SUPPLEMENT_JUDGMENT_READ_FAILED, {
      sourceId,
      judgmentId,
      sourceDocumentId,
      ...errorSystemFields(error.cause),
    });
    return {
      status: PROCESS_DECISION_STATUS.RETRYABLE,
      reason: SUPPLEMENT_RETRY_REASON.JUDGMENT_READ,
    };
  };

  /**
   * Take the supplement out of a judgment a correction says it no longer
   * belongs to, then place it again. The former holder is written first, and
   * its write leaves the supplement out (`selectComposableSupplements`); only
   * once its stored document no longer holds the text is the association
   * dropped, so a failure on the way keeps the association and the next
   * observation starts over.
   */
  const leaveFormerHolder = async (
    formerId: SafeId<"caseLawDecision">,
  ): Promise<ProcessSupplementResult> => {
    const rebuiltFormer = await rebuildStoredJudgment({
      judgmentId: formerId,
      scopedDb,
      reparseStoredRaw,
      readStoredRaw,
    });
    if (rebuiltFormer.type === "read-failed") {
      return judgmentReadFailed(formerId, rebuiltFormer.error);
    }
    if (rebuiltFormer.type === "unreadable") {
      logger.warn(SUPPLEMENT_JUDGMENT_UNREADABLE, {
        sourceId,
        judgmentId: formerId,
        sourceDocumentId,
        "error.detail": rebuiltFormer.detail,
      });
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        disposition: {
          type: "standalone",
          reason: SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE,
        },
      };
    }
    const rewritten = await processDecision({
      input: rebuiltFormer.result,
      sourceId,
      scopedDb,
      observedAt,
      observationOrder: await nextObservationOrder(),
      corpus,
      polarityRules,
    });
    if (rewritten.status === PROCESS_DECISION_STATUS.RETRYABLE) {
      return rewritten;
    }
    // The rewrite parks a supplement it leaves out; one still naming the
    // former holder is detached here.
    const detached = await scopedDb(async (tx) => {
      if (
        await detachSupplement(tx, {
          sourceId,
          sourceDocumentId,
          decisionId: formerId,
        })
      ) {
        return true;
      }
      const current = (
        await tx
          .select({ decisionId: caseLawDecisionSupplements.decisionId })
          .from(caseLawDecisionSupplements)
          .where(
            and(
              eq(caseLawDecisionSupplements.sourceId, sourceId),
              eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
            ),
          )
          .limit(1)
      ).at(0);
      return current?.decisionId === null;
    });
    if (!detached) {
      // Moved by a concurrent placement; the next observation settles it.
      return {
        status: PROCESS_DECISION_STATUS.RETRYABLE,
        reason: PROCESS_DECISION_RETRY_REASON.CONTENTION,
      };
    }
    return await processSupplement({
      supplement,
      sourceId,
      scopedDb,
      observedAt,
      nextObservationOrder,
      reparseStoredRaw,
      readStoredRaw,
      corpus,
      polarityRules,
      writeRaw,
      absorb,
    });
  };

  // A merged supplement stays with its judgment even where a ruling stored
  // since would now be picked: its text is in that judgment's document, and
  // moving it would leave the text there. Only a correction that leaves the
  // holder no longer a ruling it can join moves it.
  if (row.decisionId !== null) {
    const holder = rulings.find(({ id }) => id === row.decisionId);
    if (
      holder === undefined ||
      !supplementCanJoin({ target: supplement.target, candidate: holder })
    ) {
      return await leaveFormerHolder(row.decisionId);
    }
  }
  const judgment: SupplementJudgmentRow | null = (() => {
    if (row.decisionId !== null) {
      const holder = rulings.find(({ id }) => id === row.decisionId);
      return { id: row.decisionId, redacted: holder?.redacted === true };
    }
    return selection.type === "judgment" ? selection.judgment : null;
  })();

  const standalone = async (
    reason: SupplementStandaloneReason,
  ): Promise<ProcessSupplementResult> => {
    // The refresh check reads the publisher's hash, which a row stored before
    // supplements existed shares with this document; only its type differs,
    // and a type is what the check does not read.
    const storedType = (
      await scopedDb((tx) =>
        tx
          .select({ decisionType: caseLawDecisions.decisionType })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
            ),
          )
          .limit(1),
      )
    ).at(0);
    const written = await processDecision({
      input: supplement.document,
      sourceId,
      scopedDb,
      observedAt,
      observationOrder: await nextObservationOrder(),
      refresh:
        storedType !== undefined &&
        storedType.decisionType !== (document.decisionType ?? null)
          ? DECISION_REFRESH.ALWAYS
          : DECISION_REFRESH.WHEN_SOURCE_CHANGED,
      corpus,
      polarityRules,
    });
    return written.status === PROCESS_DECISION_STATUS.RETRYABLE
      ? written
      : {
          status: PROCESS_DECISION_STATUS.COMPLETE,
          disposition: { type: "standalone", reason },
        };
  };

  if (judgment === null) {
    return await standalone(
      selection.type === "ambiguous"
        ? SUPPLEMENT_STANDALONE_REASON.AMBIGUOUS
        : SUPPLEMENT_STANDALONE_REASON.NO_JUDGMENT,
    );
  }
  /**
   * Take the supplement's standalone row, if any, out of the corpus behind
   * its judgment, then report `disposition`. A row left standing holds the
   * cursor: reporting the placement done would leave a second public copy.
   */
  const absorbed = async (
    disposition: SupplementDisposition,
  ): Promise<ProcessSupplementResult> => {
    const outcome = await absorbComposedSupplementRows({
      scopedDb,
      sourceId,
      judgmentId: judgment.id,
      supplements: [{ kind: supplement.kind, sourceDocumentId }],
      absorb,
    });
    switch (outcome.type) {
      case "absorbed":
        return { status: PROCESS_DECISION_STATUS.COMPLETE, disposition };
      case "incomplete":
        return {
          status: PROCESS_DECISION_STATUS.RETRYABLE,
          reason: SUPPLEMENT_RETRY_REASON.ABSORB,
        };
      default: {
        outcome satisfies never;
        return panic(`Unhandled absorption: ${JSON.stringify(outcome)}`);
      }
    }
  };

  if (judgment.redacted) {
    return await absorbed({ type: "withheld", judgmentId: judgment.id });
  }

  const merged = async (): Promise<ProcessSupplementResult> =>
    await absorbed({ type: "merged", judgmentId: judgment.id });

  if (
    row.decisionId === judgment.id &&
    row.mergedSourceHash === row.sourceHash
  ) {
    return await merged();
  }

  const rebuilt = await rebuildStoredJudgment({
    judgmentId: judgment.id,
    scopedDb,
    reparseStoredRaw,
    readStoredRaw,
  });
  if (rebuilt.type === "read-failed") {
    return judgmentReadFailed(judgment.id, rebuilt.error);
  }
  if (rebuilt.type === "unreadable") {
    logger.warn(SUPPLEMENT_JUDGMENT_UNREADABLE, {
      sourceId,
      judgmentId: judgment.id,
      sourceDocumentId,
      "error.detail": rebuilt.detail,
    });
    if (row.decisionId === judgment.id) {
      // The judgment still publishes an earlier version; a standalone row
      // would be a second public copy of the same reasons.
      return {
        status: PROCESS_DECISION_STATUS.COMPLETE,
        disposition: {
          type: "standalone",
          reason: SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE,
        },
      };
    }
    return await standalone(SUPPLEMENT_STANDALONE_REASON.JUDGMENT_UNREADABLE);
  }
  const written = await processDecision({
    input: rebuilt.result,
    sourceId,
    scopedDb,
    observedAt,
    observationOrder: await nextObservationOrder(),
    corpus,
    polarityRules,
  });
  if (written.status === PROCESS_DECISION_STATUS.RETRYABLE) {
    return written;
  }

  const after = (
    await scopedDb((tx) =>
      tx
        .select({
          decisionId: caseLawDecisionSupplements.decisionId,
          mergedSourceHash: caseLawDecisionSupplements.mergedSourceHash,
          sourceHash: caseLawDecisionSupplements.sourceHash,
        })
        .from(caseLawDecisionSupplements)
        .where(
          and(
            eq(caseLawDecisionSupplements.sourceId, sourceId),
            eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
          ),
        )
        .limit(1),
    )
  ).at(0);
  if (
    after?.decisionId === judgment.id &&
    after.mergedSourceHash === after.sourceHash
  ) {
    // The judgment's write absorbed the row already, or reported that it
    // could not; asking again settles which.
    return await merged();
  }
  return await standalone(
    SUPPLEMENT_STANDALONE_REASON.JUDGMENT_WITHOUT_DOCUMENT,
  );
};

type RebuildStoredJudgmentOptions = {
  judgmentId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  reparseStoredRaw: ProcessSupplementOptions["reparseStoredRaw"];
  readStoredRaw: StoredRawResultReader;
};

type RebuiltJudgment =
  | { type: "rebuilt"; result: IngestionResult }
  | { type: "unreadable"; detail: string }
  /** Object storage did not answer; nothing is known about the payload. */
  | { type: "read-failed"; error: StoredRawReadError };

/**
 * The judgment's own observation, rebuilt from the payload stored with it,
 * as a replay rebuilds it. The payload travels with the result so the write
 * keeps the row's raw pointer on the same content-addressed object.
 */
const rebuildStoredJudgment = async ({
  judgmentId,
  scopedDb,
  reparseStoredRaw,
  readStoredRaw,
}: RebuildStoredJudgmentOptions): Promise<RebuiltJudgment> => {
  const row = (
    await scopedDb((tx) =>
      tx
        .select({
          caseNumber: caseLawDecisions.caseNumber,
          sourceDocumentId: caseLawDecisions.sourceDocumentId,
          language: caseLawDecisions.language,
          court: caseLawDecisions.court,
          ecli: caseLawDecisions.ecli,
          decisionDate: caseLawDecisions.decisionDate,
          decisionType: caseLawDecisions.decisionType,
          sourceUrl: caseLawDecisions.sourceUrl,
          documentUrl: caseLawDecisions.documentUrl,
          metadata: caseLawDecisions.metadata,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          sourceRawContentType: caseLawDecisions.sourceRawContentType,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, judgmentId))
        .limit(1),
    )
  ).at(0);
  if (row === undefined) {
    return { type: "unreadable", detail: "the judgment row is gone" };
  }
  if (row.sourceRawS3Key === null) {
    return { type: "unreadable", detail: "the judgment has no stored payload" };
  }
  const read = await readStoredRaw(row.sourceRawS3Key);
  if (Result.isError(read)) {
    return read.error.permanent
      ? { type: "unreadable", detail: read.error.message }
      : { type: "read-failed", error: read.error };
  }
  const raw = read.value;
  if (raw === null) {
    return { type: "unreadable", detail: `no object at ${row.sourceRawS3Key}` };
  }
  const reparsed = await reparseStoredRaw({
    raw,
    contentType: row.sourceRawContentType,
    caseNumber: row.caseNumber,
    sourceDocumentId: row.sourceDocumentId,
    language: row.language,
    court: row.court,
    ecli: row.ecli,
    decisionDate: row.decisionDate,
    decisionType: row.decisionType,
    sourceUrl: row.sourceUrl,
    documentUrl: row.documentUrl,
    metadata: row.metadata ?? {},
  });
  switch (reparsed.type) {
    case "rejected":
      return {
        type: "unreadable",
        detail: `${reparsed.rejection}: ${reparsed.detail}`,
      };
    case "supplement":
      return {
        type: "unreadable",
        detail: "the judgment's payload is itself a supplement",
      };
    case "parsed":
      break;
    default: {
      reparsed satisfies never;
      return panic(`Unhandled reparse outcome: ${String(reparsed)}`);
    }
  }
  if ((reparsed.result.sourceDocumentId ?? null) !== row.sourceDocumentId) {
    return {
      type: "unreadable",
      detail: `the payload names ${reparsed.result.sourceDocumentId ?? "no id"}`,
    };
  }
  return {
    type: "rebuilt",
    result: {
      ...reparsed.result,
      sourceRawBytes: raw,
      sourceRawContentType:
        row.sourceRawContentType ?? reparsed.result.sourceRawContentType,
    },
  };
};

/** A stored payload is one document; nothing here should take longer. */
const STORED_RAW_READ_TIMEOUT_MS = 30_000;

/** What a page asks the database to write: its decisions and supplements. */
const pageItemCount = ({ decisions, supplements }: SyncPage): number =>
  decisions.length + (supplements?.length ?? 0);

/**
 * The production reader of stored raw payloads. `null` only where the store
 * confirmed it holds no such object; any other failure is raised, so a
 * supplement is parked for another attempt rather than stored as if its
 * judgment had no payload.
 */
export const readStoredRawFromS3: StoredRawResultReader = async (key) => {
  const read = await Result.tryPromise({
    try: async () =>
      await readS3ObjectBounded({
        bucket: envBase.S3_BUCKET,
        key,
        maxBytes: LIMITS.corpusPayloadMaxDecompressedBytes,
        signal: AbortSignal.timeout(STORED_RAW_READ_TIMEOUT_MS),
      }),
    catch: (cause) => cause,
  });
  if (Result.isOk(read)) {
    return Result.ok(read.value);
  }
  if (isMissingS3ObjectError(read.error)) {
    return Result.ok(null);
  }
  return Result.err(
    new StoredRawReadError({
      message: `Stored payload read failed for ${key}`,
      key,
      cause: read.error,
      permanent: read.error instanceof S3ObjectBudgetError,
    }),
  );
};

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
  cycle,
  maxPages: maxPagesOverride,
  maxDecisions,
  dbSlot,
  corpus = CASE_LAW_CORPUS_DEPENDENCIES,
}: PipelineInput): Promise<PipelineResult> => {
  const adapter = getAdapter(source.adapterKey);

  if (!adapter) {
    panic(`Unknown adapter: ${source.adapterKey}`);
  }

  // Started here rather than passed in, so the budget the loop measures a page
  // against is the same one the abort it would get is derived from.
  const deadline = cycle === undefined ? undefined : startCycleDeadline(cycle);

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
  /**
   * Compiled polarity rules for this cycle. One read per language the cycle
   * meets, rather than one per decision; a rule edited mid-cycle lands on the
   * next one, which is the same bargain the background classifier makes.
   */
  const polarityRules: RuleCache = new Map();

  const maxPages = maxPagesOverride ?? adapter.maxSyncPages ?? MAX_SYNC_PAGES;
  const pageTimeout = adapter.pageTimeoutMs ?? ADAPTER_TIMEOUT.PAGE;

  const fetchObservedPage = async (
    fetchCursor: string | null,
    pageSignal: AbortSignal,
  ) =>
    await Result.tryPromise({
      try: async () =>
        await sourceLease.beforeRemoteEffect(async () => {
          // The lease renewal this callback runs behind spends budget of its
          // own, so the page admitted a moment ago may no longer fit. This is
          // the last point before the request where that can still be read.
          if (deadline && !canStartCyclePage(deadline, pageTimeout)) {
            return { type: "budget-exhausted" } as const;
          }
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

  const cycleTimeoutHalt = () => {
    logger.warn("case_law.ingestion.cycle_timeout", {
      adapterKey: adapter.key,
      cursor: cursor ?? "",
      pagesProcessed,
      inserted,
      skipped,
      remainingMs: deadline ? Math.round(remainingCycleMs(deadline)) : 0,
      pageTimeoutMs: pageTimeout,
    });
    return { type: "halt", reason: CYCLE_HALT_REASON.TIMEOUT } as const;
  };

  const fetchNextObservedPage = async () => {
    // Starting a page the remaining budget cannot cover buys nothing: the
    // cycle deadline aborts it mid-flight, its work is discarded and the
    // cycle is reported as an adapter failure instead of a timeout. Stop on
    // the last completed page, which is where the cursor already stands, and
    // spend no lease renewal on the attempt.
    if (deadline && !canStartCyclePage(deadline, pageTimeout)) {
      return cycleTimeoutHalt();
    }
    const pageSignal = deadline
      ? AbortSignal.any([deadline.signal, AbortSignal.timeout(pageTimeout)])
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
    if (observedPageResult.value.type === "budget-exhausted") {
      return cycleTimeoutHalt();
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

  const reparseStoredRaw = adapter.reparseStoredRaw;
  const nextObservationOrder = async (): Promise<bigint> => {
    await sourceLease.beforeDatabaseMark();
    return await allocateSourceObservationOrder({
      leaseToken: sourceLease.leaseToken,
      scopedDb,
      sourceId: source.id,
    });
  };

  /**
   * Place a page's supplements, one at a time, unless the page already
   * halted. Returns the page's halt reason: the one it came with, or one
   * naming a supplement that could not be placed, so the cursor holds and the
   * page is read again.
   */
  const placePageSupplements = async ({
    supplements,
    halted,
  }: {
    supplements: SyncPage["supplements"];
    halted: string | null;
  }): Promise<string | null> => {
    if (halted !== null || supplements === undefined) {
      return halted;
    }
    if (reparseStoredRaw === undefined) {
      return panic(
        `Adapter ${adapter.key} emits supplements but cannot rebuild the judgments they join`,
      );
    }
    const failures: (typeof caseLawIngestionFailures.$inferInsert)[] = [];
    for (const supplement of supplements) {
      const placed = await Result.tryPromise({
        try: async () =>
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- each supplement locks its docket and may rewrite its judgment, ordered per observation
          await processSupplement({
            supplement,
            sourceId: source.id,
            scopedDb,
            observedAt: new Date(),
            nextObservationOrder,
            reparseStoredRaw,
            readStoredRaw: readStoredRawFromS3,
            corpus,
            polarityRules,
          }),
        catch: (cause) => cause,
      });
      if (Result.isError(placed)) {
        // As a decision's failure is: recorded and stepped over, so one
        // poison supplement cannot pin the source. It is not lost: nothing
        // holds its identity, so the reconciliation lists it again.
        const { error } = placed;
        const { document } = supplement;
        logger.error("case_law.ingestion.supplement_failed", {
          adapterKey: adapter.key,
          caseNumber: document.caseNumber,
          sourceDocumentId: document.sourceDocumentId,
          ...errorSystemFields(error),
          ...pgErrorFields(error),
          "error.detail": wrappedErrorDetail(error),
        });
        captureError(error, {
          adapterKey: adapter.key,
          step: "runIngestionPipeline.processSupplement",
        });
        if (error instanceof TimeoutError) {
          await flushIngestionFailures(failures);
          return databaseTimeoutHaltReason(error);
        }
        failures.push({
          sourceId: source.id,
          caseNumber: document.caseNumber,
          language: document.language,
          errorType: errorTag(error).slice(0, 128),
          errorMessage: wrappedErrorDetail(error).slice(0, 2048),
          cursor,
        });
        continue;
      }
      if (placed.value.status === PROCESS_DECISION_STATUS.RETRYABLE) {
        await flushIngestionFailures(failures);
        return `Supplement ${supplement.document.sourceDocumentId} not placed (${placed.value.reason}); cursor held for retry`;
      }
    }
    return await flushIngestionFailures(failures);
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
    if (dbSlot && pageItemCount(page) > 0) {
      try {
        await dbSlot.acquire(deadline?.signal);
        pageHoldsDbSlot = true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          haltReason = CYCLE_HALT_REASON.TIMEOUT;
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
      // One pack for the page: every decision below contributes its payloads
      // to this batch, which is written and settled once the page is
      // processed.
      const corpusBatch = openCorpusPackBatch({
        scopedDb,
        transfer: corpus.transfer,
      });
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
              corpusBatch,
              polarityRules,
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
        // The page's pack goes out here for the same reason the failures do:
        // every mid-page exit above is a `break` or a throw, and the
        // decisions already processed have rows waiting for their payloads.
        // A decision whose settlement did not land holds the cursor, so the
        // page is retried and it joins the next batch's pack.
        //
        // A flush that fails outright is the whole page's corpus write
        // failing, counted as such: raising from a `finally` would replace
        // whatever brought the page here and skip the failure rows below.
        const corpusOutcomes = await corpusBatch.flush();
        if (Result.isError(corpusOutcomes)) {
          s3UploadFailures++;
          logger.error("case_law.ingestion.corpus_write_failed", {
            adapterKey: adapter.key,
            cursor: cursor ?? "",
            ...errorSystemFields(corpusOutcomes.error),
            ...pgErrorFields(corpusOutcomes.error),
            "error.detail": wrappedErrorDetail(corpusOutcomes.error),
          });
          captureError(corpusOutcomes.error, {
            adapterKey: adapter.key,
            step: "runIngestionPipeline.corpusPackFlush",
          });
        } else {
          for (const [settledDecisionId, outcome] of corpusOutcomes.value) {
            const settlement = processResultForCorpusOutcome(outcome, {
              decisionId: settledDecisionId,
            });
            if (settlement.status === PROCESS_DECISION_STATUS.RETRYABLE) {
              s3UploadFailures++;
            }
          }
        }
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

      // After the page's pack is flushed, so a judgment written on this page
      // is settled before its supplement writes it again, and before the
      // cursor moves, so a supplement that could not be placed holds it.
      haltReason = await placePageSupplements({
        supplements: page.supplements,
        halted: haltReason,
      });

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

  // After the checkpoint and outside its transaction: the count walks the
  // source's whole index range, and holding the leased source row's
  // transaction open for it would block the next cycle on bookkeeping. It
  // rate-limits itself to one count per source per interval and reports its
  // own failures, so its outcome never reaches this run's result.
  await refreshSourceStoredTotal({
    scopedDb,
    sourceId: source.id,
    now: new Date(),
  });

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
