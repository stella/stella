// parser-output-unchanged: document writes coordinate with source ownership; parsing is unchanged.
// parser-output-unchanged: bound the deferred queue scan; fetch processing and parsing are unchanged.
// parser-output-unchanged: fetch processing uses the atomic claim snapshot; parsing is unchanged.
// parser-output-unchanged: fetch entry takes an ID and writes require the claimed snapshot; parsing is unchanged.
// parser-output-unchanged: the PDF download is read under a byte ceiling; a download within it parses as before.
/**
 * Fetch and parse the PDFs behind Slovak court decisions.
 *
 * The `sk-courts` adapter ingests metadata only. Downloading a PDF
 * costs 5-30s, and at 4.6M decisions that would dominate the crawl, so
 * a page stores what the list and detail endpoints already give it —
 * case number, ECLI, court, date — and leaves the document itself for
 * later. "Later" is here.
 *
 * A decision waiting on this is not broken, but it is not readable
 * either: no fulltext means nothing to search, nothing to cite and
 * nothing for the AI pipeline, so the queue this drains should stay
 * short rather than merely bounded.
 *
 * Two callers share the per-decision unit below: the worker that walks
 * the queue, and the read path when a reader opens a decision the walk
 * has not reached (`decisions/document-on-demand.ts`). This module
 * defines the two tiers the queue is ordered by — what readers have
 * asked for, then the newest of the rest — while the ordering between
 * them lives in `sk-document-queue.ts`. The unit itself is idempotent,
 * because either caller may reach a decision first.
 */

import { panic, Result } from "better-result";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import { type DocumentAst, isDocumentAst } from "@stll/legal-ast/document-ast";
import {
  DOCUMENT_FETCH_OUTCOME,
  type DocumentFetchOutcome,
  type DocumentStageObserver,
} from "@stll/legal-atlas/document-fetch-diagnostics";
import { skDocumentErrorDiagnostics } from "@stll/legal-atlas/sk-document-fetch-diagnostics";
import { readCappedBytes } from "@stll/skills/streaming";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import { executedRows } from "@/api/lib/db/executed-rows";
import { errorTag } from "@/api/lib/errors/error-tag";
import type {
  ReadOutcome,
  ReadUnavailableCause,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";
import { settleReservedCaseLawCorpusUpload } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { indexDecision } from "@/api/lib/legal-search/case-law-search-index";
import {
  type ActiveCorpusProjectionSourceLock,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  deployedCorpusTransfer,
  openCorpusPackBatch,
} from "@/api/lib/legal-search/corpus-pack-batch";
import type {
  CorpusPackBatchOutcome,
  CorpusTransfer,
} from "@/api/lib/legal-search/corpus-pack-batch";
import {
  corpusMirrorColumns,
  corpusPayloadDisposition,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  CorpusPayloadColumns,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";
import {
  type DeferredDocumentOwnershipRefusal,
  type DeferredDocumentSourceFence,
  isDeferredDocumentOwnershipLost,
  withDeferredDocumentSourceOwnership,
} from "@/api/lib/legal-search/deferred-document-source-ownership";
import {
  withDocumentStageObserver,
  recordDocumentStageError,
} from "@/api/lib/legal-search/document-stage-observation";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import {
  isUnreadablePdfError,
  parseSkDecisionPdf,
} from "@/api/lib/legal-search/parsers/sk-courts";
import { segmentDecision } from "@/api/lib/legal-search/segment-decision";
import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";
import { SkDocumentNonPdfError } from "@/api/lib/legal-search/sk-document-fetch-diagnostics";
import {
  documentFetchParked,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
} from "@/api/lib/legal-search/sk-document-parking-sql";
import {
  pendingDeferredDocumentSql,
  storesNoCorpusDocumentSql,
} from "@/api/lib/legal-search/sk-document-pending-sql";
import type { PendingDocumentTierLoaders } from "@/api/lib/legal-search/sk-document-queue";
import {
  createRemainingDocumentScan,
  DOCUMENT_SCAN_PAGE_LIMIT,
  DOCUMENT_SCAN_REPROBE_MS,
} from "@/api/lib/legal-search/sk-document-remaining-scan";
import { logger } from "@/api/lib/observability/logger";
import { pgErrorFields } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/** A decision awaiting its document. */
export type PendingDocument = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  ecli: string | null;
  court: string;
  /** Jurisdiction, which partitions the decision's corpus objects. */
  country: string;
  decisionDate: string | null;
  decisionType: string | null;
  documentUrl: string | null;
};

const claimedPendingDocument = Symbol("claimedPendingDocument");

type ClaimedPendingDocument = PendingDocument & {
  readonly [claimedPendingDocument]: true;
  readonly sourceHash: string | null;
  readonly attempts: number;
};

/**
 * The gated download of one decision's PDF.
 *
 * One request per decision over a corpus of millions makes this walk the
 * largest traffic the slice sends the court's host, so every download has to
 * be counted against that publisher's budget. The gate lives in the ingestion
 * slice, which `lib` may not import, so the caller supplies it — required, and
 * never defaulted, because a call site that forgot it would download outside
 * the budget and nothing would say so. `refused-target` when the gate refuses
 * the URL as off the publisher's hosts.
 */
export type SkDocumentFetch = (
  url: URL,
  init: { signal?: AbortSignal },
) => Promise<SkDocumentRead>;

/** What one gated download established. */
export type SkDocumentRead =
  | ReadOutcome<Response>
  | { type: "refused-target"; reason: string };

export type FetchPdfBytesOptions = {
  documentUrl: string;
  fetchDocument: SkDocumentFetch;
  signal: AbortSignal;
};

/**
 * Why one decision's attempt produced no document while the queue as a
 * whole is fine. Each is that decision's own failure: it is retried behind
 * the decision's own cooldown and never slows the walk down for the rest.
 */
const DOCUMENT_FETCH_FAILURES = [
  /** The publisher refused this request with a status about the request itself. */
  "publisher-status",
  /** The publisher answered, and the body broke off or ran out of time. */
  "network",
  /** The download is a PDF the parser could not read. */
  "unparseable",
  /** The download is larger than {@link MAX_DOCUMENT_PDF_BYTES}. */
  "too-large",
] as const;

export type DocumentFetchFailure = (typeof DOCUMENT_FETCH_FAILURES)[number];

export const DOCUMENT_FETCH_FAILURE = {
  PUBLISHER_STATUS: DOCUMENT_FETCH_FAILURES[0],
  NETWORK: DOCUMENT_FETCH_FAILURES[1],
  UNPARSEABLE: DOCUMENT_FETCH_FAILURES[2],
  TOO_LARGE: DOCUMENT_FETCH_FAILURES[3],
} as const satisfies Record<string, DocumentFetchFailure>;

/**
 * The most bytes one decision's PDF download may hold. Generous for a court
 * decision, scanned ones included; a larger body is refused before it is
 * buffered, and the decision is parked rather than stored without its text.
 */
export const MAX_DOCUMENT_PDF_BYTES = 32 * 1024 * 1024;

/** The leading bytes kept of a body over the ceiling, for its type check. */
const OVERSIZED_PREFIX_BYTES = 1024;

/** What one download produced. */
export type PdfFetchResult =
  | { type: "document"; bytes: Uint8Array }
  /** The publisher states there is nothing to fetch. */
  | { type: "absent" }
  /**
   * The body ran past `limitBytes`; reading stopped there. `prefix` holds its
   * leading bytes, so a body that is not a PDF is still refused as one; null
   * where the reader that stopped kept none.
   */
  | { type: "too-large"; limitBytes: number; prefix: Uint8Array | null }
  | {
      type: "failed";
      failure: Exclude<DocumentFetchFailure, "unparseable" | "too-large">;
      /** A short tag for telemetry: the status or the error's code. */
      detail: string;
    };

/**
 * Client-error statuses that describe the publisher or this client rather
 * than the requested document: credentials (401, 407), a refused client
 * (403), and a request for less traffic (408, 429). With every 5xx, they
 * answer for the next document as much as for this one.
 */
const PUBLISHER_WIDE_CLIENT_STATUSES = new Set([401, 403, 407, 408, 429]);

/** A refusal that belongs to the requested document alone. */
const isDocumentOwnStatus = (status: number): boolean =>
  status >= 400 && status < 500 && !PUBLISHER_WIDE_CLIENT_STATUSES.has(status);

/**
 * The tag of a body that broke off after the publisher answered: Bun reports
 * a reset mid-body as a `TypeError` carrying a string `code`, and a body that
 * ran out of time as a `TimeoutError`. Anything else (an abort on drain, a
 * programming error) is not this document's and is left to throw.
 */
const brokenBodyDetail = (error: unknown): string | undefined => {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return error.name;
  }
  if (
    error instanceof TypeError &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return `${error.name}:${error.code}`;
  }
  return undefined;
};

type CappedBody =
  | { type: "complete"; bytes: Uint8Array }
  | { type: "over"; prefix: Uint8Array };

/**
 * Read a body up to {@link MAX_DOCUMENT_PDF_BYTES}, keeping the leading bytes
 * of one that runs past it. The leading bytes are copied as they pass, so
 * nothing is read twice or past the ceiling.
 */
const readCappedDocumentBody = async (
  body: ReadableStream<Uint8Array>,
): Promise<CappedBody> => {
  const prefix = new Uint8Array(OVERSIZED_PREFIX_BYTES);
  let prefixBytes = 0;
  const bytes = await readCappedBytes(body, MAX_DOCUMENT_PDF_BYTES, (chunk) => {
    if (prefixBytes >= OVERSIZED_PREFIX_BYTES) {
      return;
    }
    const part = chunk.subarray(0, OVERSIZED_PREFIX_BYTES - prefixBytes);
    prefix.set(part, prefixBytes);
    prefixBytes += part.byteLength;
  });
  return bytes === null
    ? { type: "over", prefix: prefix.subarray(0, prefixBytes) }
    : { type: "complete", bytes };
};

/**
 * Download one decision's document.
 *
 * A failure comes back as `failed` only when it belongs to this document: a
 * client-error status about the request itself, or a body that broke off after
 * the publisher answered. Everything that answers for every document at once
 * throws, so the caller backs off: a connection that never got an answer, any
 * 5xx, and the statuses in `PUBLISHER_WIDE_CLIENT_STATUSES`. A status no rule
 * names throws too; backing off for a document costs a delay, while treating
 * an outage as per-document failures spends every document's attempts.
 */
export const fetchPdfBytes = async ({
  documentUrl,
  fetchDocument,
  signal,
}: FetchPdfBytesOptions): Promise<PdfFetchResult> => {
  const target = restrictSkCourtDocumentUrl(documentUrl);
  if (target === null) {
    // Persisted legacy rows can predate the provider boundary. Returning the
    // terminal unavailable outcome lets the caller drain them from the queue;
    // retrying cannot make an off-origin URL become trusted.
    return { type: "absent" };
  }

  const read = await fetchDocument(target, { signal });
  switch (read.type) {
    case "refused-target":
    case "absent":
      return { type: "absent" };
    case "present":
      return await servedPdfBytes(read.value);
    case "refused":
      return publisherStatusPdf(read.status);
    case "unavailable":
      return unavailablePdf(read.cause);
    default:
      read satisfies never;
      return panic(`Unhandled document read: ${String(read)}`);
  }
};

/** The body of a served download, capped, or the failure of reading it. */
const servedPdfBytes = async (response: Response): Promise<PdfFetchResult> => {
  const body = await Result.tryPromise({
    try: async (): Promise<CappedBody> =>
      response.body === null
        ? { type: "complete", bytes: new Uint8Array() }
        : await readCappedDocumentBody(response.body),
    catch: (error) => error,
  });
  if (Result.isOk(body)) {
    return body.value.type === "complete"
      ? { type: "document", bytes: body.value.bytes }
      : {
          type: "too-large",
          limitBytes: MAX_DOCUMENT_PDF_BYTES,
          prefix: body.value.prefix,
        };
  }
  await recordDocumentStageError(ADAPTER_KEYS.SK_COURTS, body.error);
  const detail = brokenBodyDetail(body.error);
  if (detail === undefined) {
    throw body.error;
  }
  return { type: "failed", failure: DOCUMENT_FETCH_FAILURE.NETWORK, detail };
};

/**
 * A download that served no document. Only a 404 or 410 proves there is
 * none, and those arrive as `absent`; an empty 204 is this document's own
 * failure, and a request that threw is rethrown as it was.
 */
const unavailablePdf = (cause: ReadUnavailableCause): PdfFetchResult => {
  switch (cause.kind) {
    case "thrown":
      throw cause.error instanceof Error
        ? cause.error
        : new AdapterFetchError({
            message: "Document fetch failed",
            adapterKey: ADAPTER_KEYS.SK_COURTS,
            cursor: null,
            cause: cause.error,
          });
    case "no-content":
      return {
        type: "failed",
        failure: DOCUMENT_FETCH_FAILURE.PUBLISHER_STATUS,
        detail: `http-${cause.status}`,
      };
    case "too-large":
      return { type: "too-large", limitBytes: cause.maxBytes, prefix: null };
    case "status":
    case "empty-body":
      return publisherStatusPdf(cause.status);
    default:
      cause satisfies never;
      return panic(`Unhandled read cause: ${String(cause)}`);
  }
};

/**
 * A status about this one document is its own failure; any other ends the
 * walk's batch with the status.
 */
const publisherStatusPdf = (status: number): PdfFetchResult => {
  if (isDocumentOwnStatus(status)) {
    return {
      type: "failed",
      failure: DOCUMENT_FETCH_FAILURE.PUBLISHER_STATUS,
      detail: `http-${status}`,
    };
  }
  throw new AdapterFetchError({
    message: `Document fetch returned ${status}`,
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    cursor: null,
    httpStatus: status,
  });
};

export type BackfilledDocument = {
  fulltext: string;
  documentAst: DocumentAst;
  sections: ReturnType<typeof segmentDecision>;
};

/**
 * Parse one decision's PDF into the same shape ingestion would have
 * produced. Runs the bytes through `sanitizeResult` so a backfilled
 * row is byte-for-byte what the pipeline would have written, rather
 * than a second normalization that drifts from it.
 */
export const parsePendingDocument = async (
  pending: PendingDocument,
  pdfBytes: Uint8Array,
): Promise<BackfilledDocument | undefined> => {
  const parsed = await parseSkDecisionPdf({
    pdfBytes,
    caseNumber: pending.caseNumber,
    ecli: pending.ecli ?? undefined,
    court: pending.court,
    decisionDate: pending.decisionDate ?? undefined,
    decisionType: pending.decisionType ?? undefined,
  });

  if (parsed.documentAst.blocks.length === 0 || parsed.fulltext === "") {
    return undefined;
  }

  const sanitized = sanitizeResult({
    caseNumber: pending.caseNumber,
    court: pending.court,
    country: "SVK",
    language: "sk",
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: "",
    fulltext: parsed.fulltext,
    documentAst: parsed.documentAst,
  });

  const fulltext = sanitized.fulltext ?? "";
  // `sanitizeResult` drops an AST it cannot round-trip, so a sanitized
  // document that lost its blocks is treated as unparseable rather
  // than stored half-formed.
  if (fulltext === "" || !isDocumentAst(sanitized.documentAst)) {
    return undefined;
  }

  return {
    fulltext,
    documentAst: sanitized.documentAst,
    sections: segmentDecision(fulltext),
  };
};

/**
 * Attempts after which a requested decision stops jumping the queue.
 * Without it one document the court will never serve would hold the
 * front of the priority tier and starve every other request.
 */
export const MAX_PRIORITY_FETCH_ATTEMPTS = 5;

const PENDING_DOCUMENT_COLUMNS = {
  id: caseLawDecisions.id,
  caseNumber: caseLawDecisions.caseNumber,
  ecli: caseLawDecisions.ecli,
  court: caseLawDecisions.court,
  country: caseLawDecisions.country,
  decisionDate: caseLawDecisions.decisionDate,
  decisionType: caseLawDecisions.decisionType,
  documentUrl: caseLawDecisions.documentUrl,
};

/**
 * Attempts after which a decision leaves the walk altogether. Defined beside
 * the SQL that tests it, which the schema's parked-row index shares.
 */
export { MAX_DOCUMENT_FETCH_ATTEMPTS };

/**
 * How long the queue leaves a decision alone after its first attempt.
 * Each further attempt doubles it, up to `FETCH_COOLDOWN_MAX_DOUBLINGS`
 * doublings, so a document that keeps failing costs fewer downloads the
 * longer it fails, and reaches the parking threshold in weeks rather
 * than days.
 *
 * The cooldown is per decision and is the whole retry delay: a failure
 * never slows the walk for the decisions behind it. Far longer than the
 * claim's own TTL, which only guards one fetch in flight; a reader who
 * opens the decision again is not held by this, because the read-through
 * claims directly.
 */
const FETCH_COOLDOWN_BASE_HOURS = 6;
const FETCH_COOLDOWN_MAX_DOUBLINGS = 4;

/** The decision's current cooldown, from its attempt count. */
const fetchCooldown = sql`make_interval(hours => ${FETCH_COOLDOWN_BASE_HOURS}::int * power(2, least(greatest(${caseLawDecisions.documentFetchAttempts} - 1, 0), ${FETCH_COOLDOWN_MAX_DOUBLINGS}::int))::int)`;

const outsideFetchCooldown = or(
  isNull(caseLawDecisions.documentFetchAttemptedAt),
  lt(
    caseLawDecisions.documentFetchAttemptedAt,
    sql`now() - ${fetchCooldown}::interval`,
  ),
);

const belowParkingThreshold = lt(
  caseLawDecisions.documentFetchAttempts,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
);

/**
 * A decision whose document has not been fetched yet: nothing readable
 * anywhere, and something to fetch. An empty string is the "tried and
 * got nothing" marker and is deliberately not NULL, so it leaves the
 * queue.
 *
 * A NULL text column is not enough on its own. Under canonical storage
 * the payload lives in object storage and the column trim nulls the
 * columns by design, so every drained decision would read as pending
 * again and the queue would re-fetch the whole corpus forever. The
 * content hash is what distinguishes the two: absent (nothing was ever
 * written to object storage) or one of the empty shapes (written before
 * the document existed) means there is still nothing to read.
 *
 * The outstanding indexes share the exact predicate, including the corpus
 * hash test, so corpus-served rows leave the indexed queue after trimming.
 */
/**
 * SQL for "object storage holds no document for this row".
 *
 * The text column cannot answer this on its own. Under canonical storage a
 * stored document leaves the columns null by design, so every predicate
 * that means "nothing is stored here" has to consult the durable corpus
 * state as well, or it will read a corpus-served decision as empty work.
 * Derived once and shared by the three predicates that ask it, so the
 * queue's idea of pending cannot drift from the guards that protect a
 * stored payload from being erased.
 *
 * A row whose corpus hash is row-specific but whose Postgres AST column is
 * still present is a legacy empty-envelope copy, not a corpus-served
 * document: a trimmed row has had every payload column nulled, so a
 * surviving AST artifact marks the corpus object as a verbatim copy of a
 * payload that carries no document.
 */
export const storesNoCorpusDocument =
  storesNoCorpusDocumentSql(caseLawDecisions);

export const pendingDocumentPredicate =
  pendingDeferredDocumentSql(caseLawDecisions);

/** Pending, asked for by a reader, and still within its retry budget. */
export const requestedDocumentPredicate = and(
  pendingDocumentPredicate,
  outsideFetchCooldown,
  isNotNull(caseLawDecisions.documentFetchRequestedAt),
  lt(caseLawDecisions.documentFetchAttempts, MAX_PRIORITY_FETCH_ATTEMPTS),
);

/**
 * Everything else: never asked for, or asked for and out of retries,
 * and not yet parked.
 */
export const remainingDocumentPredicate = and(
  pendingDocumentPredicate,
  outsideFetchCooldown,
  belowParkingThreshold,
  or(
    isNull(caseLawDecisions.documentFetchRequestedAt),
    gte(caseLawDecisions.documentFetchAttempts, MAX_PRIORITY_FETCH_ATTEMPTS),
  ),
);

/**
 * Pending, and out of the walk until an operator requeues it.
 *
 * The attempt test is `documentFetchParked`, the text that also defines
 * `case_law_decisions_document_parked_idx`, so the planner can prove this
 * predicate implies the index's and read the few parked rows from it instead
 * of the pending backlog. The rest of the pending predicate stays a heap
 * filter.
 */
export const parkedDocumentPredicate = and(
  pendingDocumentPredicate,
  documentFetchParked(caseLawDecisions.documentFetchAttempts),
);

/** Oldest request first, so a reader waits for one drain at most. */
export const requestedDocumentOrder = [
  asc(caseLawDecisions.documentFetchRequestedAt),
  asc(caseLawDecisions.id),
] as const;

/**
 * Newest decision first, among the decisions that are ready to be tried.
 *
 * Readiness is the predicate's, not this order's: `outsideFetchCooldown`
 * already admits only a decision never attempted or attempted longer ago
 * than the cooldown, so every row this orders is one the queue may hand
 * out now. That is what bounds a document the source keeps refusing —
 * one attempt per cooldown, not one per pass.
 *
 * Attempt count deliberately does not lead. It reads as a tie-break but
 * behaves as a partition: with a backlog of untried decisions, every row
 * that failed once sorts behind all of them, so its retry waits for the
 * backlog to drain rather than for its cooldown to pass. The cooldown is
 * the retry delay; the order must not turn it into the backlog length.
 *
 * NULLS LAST matches the index and puts undated decisions after every
 * dated one, rather than at the head of a DESC scan.
 */
export const remainingDocumentOrder = [
  sql`${caseLawDecisions.decisionDate} desc nulls last`,
  asc(caseLawDecisions.id),
] as const;

/**
 * Keyset position in the requested tier: the previous page's last row.
 * Only its id travels, because the boundary's
 * `(document_fetch_requested_at, id)` pair is read back in the database.
 * `document_fetch_requested_at` is written by SQL `now()` and therefore
 * carries microseconds, which a JS `Date` boundary would truncate to the
 * millisecond; the ascending `>` comparison would then still admit the row
 * the page was cut at and re-emit it at the head of every following page.
 */
export type RequestedDocumentCursor = SafeId<"caseLawDecision">;

/** Keyset position in the remaining tier (decisionDate, id). */
export type RemainingDocumentCursor = {
  decisionDate: string | null;
  id: SafeId<"caseLawDecision">;
};

type LoadTierOptions<TCursor> = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  limit: number;
  after?: TCursor;
};

/**
 * The source whose adapter stores metadata during the crawl and leaves
 * the document to this queue. Resolved once per sweep so the queue
 * filters decisions by an indexed `source_id` instead of joining the
 * whole backlog against the source table.
 */
export const loadDeferredDocumentSourceId = async (
  scopedDb: ScopedDb,
): Promise<SafeId<"caseLawSource"> | undefined> => {
  const source = await scopedDb((tx) =>
    tx.query.caseLawSources.findFirst({
      where: { adapterKey: { eq: ADAPTER_KEYS.SK_COURTS } },
      columns: { id: true },
    }),
  );
  return source?.id;
};

/**
 * The one query shape both tiers use. They differ only in predicate and
 * order, so they share the builder: a second chain would buy nothing
 * but another few hundred thousand type instantiations.
 */
const loadTier = async ({
  scopedDb,
  where,
  orderBy,
  limit,
}: {
  scopedDb: ScopedDb;
  where: SQL | undefined;
  orderBy: readonly SQL[];
  limit: number;
}): Promise<PendingDocument[]> =>
  await scopedDb((tx) =>
    tx
      .select(PENDING_DOCUMENT_COLUMNS)
      .from(caseLawDecisions)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit),
  );

/** Requested tier: oldest request first, so a reader waits once. */
export const loadRequestedDocuments = async ({
  scopedDb,
  sourceId,
  limit,
  after,
}: LoadTierOptions<RequestedDocumentCursor>): Promise<PendingDocument[]> =>
  await loadTier({
    scopedDb,
    limit,
    orderBy: requestedDocumentOrder,
    where: and(
      eq(caseLawDecisions.sourceId, sourceId),
      requestedDocumentPredicate,
      after
        ? sql`(${caseLawDecisions.documentFetchRequestedAt}, ${caseLawDecisions.id}) > (select b.document_fetch_requested_at, b.id from case_law_decisions b where b.id = ${after})`
        : undefined,
    ),
  });

/**
 * Keyset boundary for `decision_date DESC NULLS LAST, id ASC`. A NULL
 * date sorts after every date, so a cursor on a dated row also has to
 * admit the undated tail, and a cursor already in that tail is ordered
 * by id alone.
 */
const remainingCursorPredicate = ({
  decisionDate,
  id,
}: RemainingDocumentCursor) =>
  decisionDate === null
    ? and(isNull(caseLawDecisions.decisionDate), gt(caseLawDecisions.id, id))
    : or(
        lt(caseLawDecisions.decisionDate, decisionDate),
        isNull(caseLawDecisions.decisionDate),
        and(
          eq(caseLawDecisions.decisionDate, decisionDate),
          gt(caseLawDecisions.id, id),
        ),
      );

/**
 * One-shot remaining-tier page: newest decision first. The continuous
 * drain uses bounded outstanding candidate pages below so cooldown rows
 * cannot make a cycle scan the entire ready-tier backlog.
 * A fresh decision is the one a
 * reader is most likely to open next, and the crawl adds to this end of
 * the range, so draining from it keeps the readable window current
 * instead of chasing the oldest page in the archive.
 */
export const loadRemainingDocuments = async ({
  scopedDb,
  sourceId,
  limit,
  after,
}: LoadTierOptions<RemainingDocumentCursor>): Promise<PendingDocument[]> =>
  await loadTier({
    scopedDb,
    limit,
    orderBy: remainingDocumentOrder,
    where: and(
      eq(caseLawDecisions.sourceId, sourceId),
      remainingDocumentPredicate,
      after ? remainingCursorPredicate(after) : undefined,
    ),
  });

/** Readiness is projected after the indexed candidate LIMIT, never a scan filter. */
export const remainingDocumentCandidateQuery = ({
  tx,
  sourceId,
  limit,
  after,
}: {
  tx: Transaction;
  sourceId: SafeId<"caseLawSource">;
  limit: number;
  after?: RemainingDocumentCursor;
}) => {
  const pageLimit = Math.min(limit, DOCUMENT_SCAN_PAGE_LIMIT);
  const page = (cursorWhere?: SQL) =>
    tx
      .select({
        ...PENDING_DOCUMENT_COLUMNS,
        ready: sql<boolean>`coalesce(${remainingDocumentPredicate}, false)`.as(
          "ready",
        ),
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          pendingDocumentPredicate,
          cursorWhere,
        ),
      )
      .orderBy(...remainingDocumentOrder)
      .limit(pageLimit);
  if (after === undefined) {
    return page(undefined);
  }
  if (after.decisionDate === null) {
    return page(remainingCursorPredicate(after));
  }
  // Mixed DESC/ASC order cannot use a tuple comparison. Separate tight
  // ranges prevent the OR boundary becoming a filter over the entire prefix.
  const candidates = page(
    and(
      eq(caseLawDecisions.decisionDate, after.decisionDate),
      gt(caseLawDecisions.id, after.id),
    ),
  )
    .unionAll(page(lt(caseLawDecisions.decisionDate, after.decisionDate)))
    .unionAll(page(isNull(caseLawDecisions.decisionDate)))
    .as("outstanding_candidates");
  return tx
    .select()
    .from(candidates)
    .orderBy(
      sql`${candidates.decisionDate} desc nulls last`,
      asc(candidates.id),
    )
    .limit(pageLimit);
};

/**
 * Whether any document remains outstanding, including work that is cooling
 * down or parked. Its exact partial index excludes corpus-served rows;
 * LIMIT 1 stops at the first outstanding row instead of counting or walking
 * the ready queue tiers, which intentionally omit work not ready now.
 */
export const pendingDocumentPresenceQuery = ({
  sourceId,
  tx,
}: {
  sourceId: SafeId<"caseLawSource">;
  tx: Transaction;
}) =>
  tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(eq(caseLawDecisions.sourceId, sourceId), pendingDocumentPredicate),
    )
    .limit(1);

/** Bounded existence probe over one source's outstanding deferred documents. */
export const hasPendingDeferredDocumentsForSource = async ({
  scopedDb,
  sourceId,
}: {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
}): Promise<boolean> =>
  await scopedDb(
    async (tx) =>
      (await pendingDocumentPresenceQuery({ sourceId, tx })).length > 0,
  );

/** Bounded existence probe for the registered deferred-document source. */
export const hasPendingDeferredDocuments = async (
  scopedDb: ScopedDb,
): Promise<boolean> => {
  const sourceId = await loadDeferredDocumentSourceId(scopedDb);
  return sourceId === undefined
    ? false
    : await hasPendingDeferredDocumentsForSource({ scopedDb, sourceId });
};

/**
 * Bind both tiers to a database handle.
 *
 * The source id is resolved on first use and kept: it never changes for
 * the life of a process, and both tier queries filter on it so they hit
 * the partial indexes instead of joining the backlog against the source
 * table. An unresolved source (the adapter has not ingested anything
 * yet) reads as an empty queue rather than an error, so a worker started
 * before the first crawl idles instead of failing.
 */
export const scopedPendingDocumentTierLoaders = (
  scopedDb: ScopedDb,
): PendingDocumentTierLoaders => {
  let sourceId: SafeId<"caseLawSource"> | undefined;
  let sourceReprobeAt = Number.NEGATIVE_INFINITY;

  const resolveSourceId = async (): Promise<
    SafeId<"caseLawSource"> | undefined
  > => {
    if (
      sourceId !== undefined ||
      Temporal.Now.instant().epochMilliseconds < sourceReprobeAt
    ) {
      return sourceId;
    }
    sourceId = await loadDeferredDocumentSourceId(scopedDb);
    sourceReprobeAt =
      Temporal.Now.instant().epochMilliseconds + DOCUMENT_SCAN_REPROBE_MS;
    return sourceId;
  };

  const loadRemaining = createRemainingDocumentScan({
    loadPage: async ({ limit, after }) => {
      const id = await resolveSourceId();
      return id === undefined
        ? []
        : await scopedDb((tx) =>
            remainingDocumentCandidateQuery({
              tx,
              sourceId: id,
              limit,
              ...(after ? { after } : {}),
            }),
          );
    },
  });

  return {
    loadRequested: async (limit) => {
      const id = await resolveSourceId();
      return id === undefined
        ? []
        : await loadRequestedDocuments({ scopedDb, sourceId: id, limit });
    },
    loadRemaining,
  };
};

/**
 * One ready page: decisions a reader asked for first, then the newest
 * of the rest. The worker's continuous stream additionally limits rows
 * examined before checking readiness; see `sk-document-queue.ts`.
 */
export const loadPendingDocuments = async (
  scopedDb: ScopedDb,
  limit: number,
): Promise<PendingDocument[]> => {
  const sourceId = await loadDeferredDocumentSourceId(scopedDb);
  if (sourceId === undefined) {
    return [];
  }
  const requested = await loadRequestedDocuments({ scopedDb, sourceId, limit });
  if (requested.length >= limit) {
    return requested;
  }

  const remaining = await loadRemainingDocuments({
    scopedDb,
    sourceId,
    limit: limit - requested.length,
  });
  return [...requested, ...remaining];
};

/**
 * How this store reaches object storage, or null where corpus storage is
 * off and the Postgres columns are the whole of it.
 */
export const corpusBackfillTransfer = (): CorpusTransfer | null =>
  corpusStorageMode === "off" ? null : deployedCorpusTransfer();

export type StoreBackfilledDocumentOptions = {
  decision: ClaimedPendingDocument;
  document: BackfilledDocument;
  scopedDb: ScopedDb;
  /**
   * Seam for tests, which drive the corpus path without a bucket and
   * without depending on which module happened to read the environment
   * first. It carries the layout it serves, so a test cannot hand over a
   * client the batch would never call. Production passes nothing.
   */
  transfer?: CorpusTransfer | null;
  /**
   * Storage mode this store settles under. Production passes nothing;
   * tests set it for the same reason they inject the writer, so the
   * canonical path is exercised without depending on which module read
   * the environment first.
   */
  mode?: CorpusStorageMode;
};

/**
 * The row still holds the source version its fetch was claimed on. Every
 * write a fetch decides (store, unavailable, park) carries it, so a source
 * refresh landing mid-fetch takes the late write out of scope instead of
 * letting a verdict on the old version land on the new one.
 */
const holdsClaimedSource = (claimedSourceHash: string | null) =>
  sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${claimedSourceHash}`;

type CorpusOutcomeContext = { decisionId: SafeId<"caseLawDecision"> };

/**
 * A batch outcome as this store reports it.
 *
 * Only a settled decision stores a document. Everything else leaves the row
 * exactly as it was — still queued, still without text — so the next pass
 * fetches it again; reporting it as stored would name a document that is not
 * there. A failed transfer is that same durable state plus a cause, so the
 * cause is captured rather than dropped on the way out.
 */
const storedForCorpusOutcome = (
  outcome: CorpusPackBatchOutcome | undefined,
  { decisionId }: CorpusOutcomeContext,
): boolean => {
  switch (outcome?.type) {
    case "settled":
      return true;
    case undefined:
    case "redacted-or-missing":
    case "busy":
    case "retry":
      return false;
    case "failed":
      if (isDeferredDocumentOwnershipLost(outcome.error)) {
        throw outcome.error;
      }
      captureError(outcome.error, {
        decisionId,
        step: "storeBackfilledDocument.corpusBatchWrite",
      });
      return false;
    default:
      outcome satisfies never;
      return panic(`Unhandled corpus batch outcome: ${String(outcome)}`);
  }
};

/**
 * Write a parsed document onto its decision and re-index it. Without
 * the re-index the row gains fulltext that search cannot see, which is
 * indistinguishable from the state this is fixing.
 *
 * Where corpus storage is on, the document is written there too, and
 * the row's keys and content hash move to the new objects in the same
 * statement as the columns. A metadata-first ingest has already written
 * an empty payload and pointed the row at it, so filling only the
 * columns would leave every corpus-preferring reader — and the corpus
 * indexer, which compares hashes — looking at the empty one. The keys
 * are content-addressed, so the real document lands at new keys and the
 * empty objects become unreachable orphans.
 *
 * Object storage goes first: no row may point at an object that is not
 * there yet. A corpus failure therefore leaves the decision exactly as
 * it was — still queued, no text — rather than storing text that
 * readers of the canonical payload cannot see.
 *
 * Under `canonical` storage the row write goes one step further and
 * leaves the payload columns null: the objects are already confirmed at
 * that point, so writing the columns too would recreate the very state
 * the mode exists to retire. The queue does not hand such a row back —
 * its predicate reads a row-specific content hash with no surviving AST
 * artifact as corpus-served, not pending.
 *
 * The row write is conditional on the row still having no text, so two
 * fetches of the same decision converge on one stored document instead
 * of the later writer overwriting the earlier one. Both write identical
 * bytes to identical keys, so the loser's objects are the winner's. The
 * re-index runs either way: it reads the stored row, so it is
 * idempotent and it also repairs a decision whose text landed but whose
 * index write did not.
 */
const storeBackfilledDocumentOwned = async ({
  decision,
  document,
  transfer = corpusBackfillTransfer(),
  mode = corpusStorageMode,
  fence,
}: Omit<StoreBackfilledDocumentOptions, "scopedDb"> & {
  fence: DeferredDocumentSourceFence;
}): Promise<"stored" | "superseded"> => {
  const { scopedDb } = fence;
  const sections = document.sections.length > 0 ? document.sections : null;
  const ownerPredicate = and(
    eq(caseLawDecisions.id, decision.id),
    eq(caseLawDecisions.sourceId, fence.sourceId),
    isNull(caseLawDecisions.redactedAt),
    sql`coalesce(${caseLawDecisions.fulltext}, '') = ''`,
    // The text column stops being the whole answer once a canonical store
    // nulls it: without this, a store whose parse outlived its claim would
    // read a decision another attempt already filled as still empty and
    // overwrite it.
    storesNoCorpusDocument,
    holdsClaimedSource(decision.sourceHash),
  );

  const storedPayloadColumns = {
    fulltext: document.fulltext,
    documentAst: document.documentAst,
    sections,
  } satisfies CorpusPayloadColumns;

  const applyStoredPayload = async (
    tx: Transaction,
    written: WriteCorpusResult | null,
    projectionLock: ActiveCorpusProjectionSourceLock | null,
  ): Promise<boolean> => {
    // Under canonical storage the payload this store just wrote to object
    // storage is the one readers get, so persisting it into the columns as
    // well would put the row back in the pre-cutover shape the moment
    // after it left it. The disposition is decided from the confirmed
    // write, so a corpus failure (which never reaches this callback) still
    // leaves the columns as the only copy.
    const payloadColumns =
      corpusPayloadDisposition({ mode, written }) === "trim"
        ? TRIMMED_CORPUS_PAYLOAD_COLUMNS
        : storedPayloadColumns;
    // audit: skip — queue backfill of public case-law text; no user action
    const applied = await tx
      .update(caseLawDecisions)
      .set({
        ...payloadColumns,
        parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
        documentFetchAttempts: sql`greatest(${caseLawDecisions.documentFetchAttempts}, ${decision.attempts}::int)`,
        ...corpusMirrorColumns({
          status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
          written,
        }),
      })
      .where(ownerPredicate)
      .returning({ id: caseLawDecisions.id });
    if (applied.length > 0 && projectionLock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: projectionLock,
        subject: { family: "case_law", entityId: decision.id },
      });
    }
    return applied.length > 0;
  };

  let stored: boolean;
  if (transfer === null) {
    stored = await scopedDb(async (tx) => {
      const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, {
        family: "case_law",
        entityId: decision.id,
      });
      return await applyStoredPayload(tx, null, projectionLock);
    });
  } else {
    // One decision, so a batch of one member set: the same path a page of
    // the pipeline takes, rather than a second writer with its own rules.
    const fencedTransfer: CorpusTransfer =
      transfer.layout === "packs"
        ? {
            layout: "packs",
            putPacks: async (...args) =>
              await fence.beforeRemoteEffect(
                async () => await transfer.putPacks(...args),
              ),
          }
        : {
            layout: "objects",
            writeObjects: async (...args) =>
              await fence.beforeRemoteEffect(
                async () => await transfer.writeObjects(...args),
              ),
          };
    const batch = openCorpusPackBatch({
      scopedDb,
      transfer: fencedTransfer,
      signal: fence.signal,
    });
    batch.enqueue({
      decisionId: decision.id,
      jurisdiction: decision.country,
      payload: {
        text: document.fulltext,
        sections,
        ast: document.documentAst,
      },
      // The queue admits only rows whose corpus stores no document
      // (`storesNoCorpusDocument`), so no recorded write can match the
      // fetched document's payload; there is nothing to compare.
      stored: null,
      settle: async ({ intentId, written: packed }) => {
        const outcome = await settleReservedCaseLawCorpusUpload({
          apply: async ({ projectionLock, tx, written }) => ({
            type: (await applyStoredPayload(tx, written, projectionLock))
              ? "applied"
              : "superseded",
          }),
          decisionId: decision.id,
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
          written: packed,
        });
        switch (outcome.type) {
          case "applied":
            return { type: "settled" };
          case "superseded":
          case "intent-reclaimed":
            return { type: "retry" };
          case "redacted-or-missing":
            return { type: "redacted-or-missing" };
          default:
            outcome satisfies never;
            return panic(`Unhandled settlement: ${String(outcome)}`);
        }
      },
    });
    const flushed = await batch.flush();
    if (
      Result.isError(flushed) &&
      isDeferredDocumentOwnershipLost(flushed.error)
    ) {
      throw flushed.error;
    }
    await fence.assertOwned();
    stored = storedForCorpusOutcome(
      Result.isError(flushed)
        ? { type: "failed", error: flushed.error }
        : flushed.value.get(decision.id),
      { decisionId: decision.id },
    );
  }

  const projection = await Result.tryPromise({
    try: async () => await indexDecision(decision.id, scopedDb),
    catch: (error) => error,
  });
  const indexed = projection.andThen((result) => result);
  if (Result.isError(indexed)) {
    // The text is stored; its projection is derived state the search-index
    // backfill reselects while the row is missing. Failing the store here
    // would make the queue fetch and parse the document again only to find
    // the row already filled.
    captureError(indexed.error, {
      decisionId: decision.id,
      step: "storeBackfilledDocument.indexDecision",
    });
    logger.error("case_law.search_index.store_projection_failed", {
      decisionId: decision.id,
      ...errorSystemFields(indexed.error),
      ...pgErrorFields(indexed.error),
    });
  }
  // A missed compare-and-set is a superseded store, not a stored document:
  // the source moved while this fetch was in flight, and the queue's next
  // pass fetches the current version. Reporting it as stored would count a
  // document that is not there.
  return stored ? "stored" : "superseded";
};

type WriteFetchBookkeepingOptions = {
  set: {
    documentFetchRequestedAt?: SQL;
    documentFetchAttempts?: number | SQL;
  };
  where: SQL | undefined;
};

/**
 * The one writer of the queue's own bookkeeping on a decision: who asked for
 * it and how many attempts it has had. None of it is a change to the
 * decision, so `updated_at` is held where it is; the public reads key their
 * freshness off it. Returns the ids it wrote.
 */
const writeFetchBookkeeping = async (
  tx: Transaction,
  { set, where }: WriteFetchBookkeepingOptions,
): Promise<{ id: SafeId<"caseLawDecision"> }[]> =>
  // audit: skip — queue bookkeeping on public case-law rows; no user action
  await tx
    .update(caseLawDecisions)
    .set({ ...set, updatedAt: sql`${caseLawDecisions.updatedAt}` })
    .where(where)
    .returning({ id: caseLawDecisions.id });

/**
 * Record that a reader asked for this document. Only the first request
 * is kept: the queue orders by it, and refreshing the timestamp on every
 * view would send a popular decision to the back of its own tier.
 */
export const recordDocumentFetchRequest = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<void> => {
  await scopedDb(
    async (tx) =>
      await writeFetchBookkeeping(tx, {
        set: { documentFetchRequestedAt: sql`now()` },
        where: and(
          eq(caseLawDecisions.id, decisionId),
          isNull(caseLawDecisions.redactedAt),
          isNull(caseLawDecisions.documentFetchRequestedAt),
        ),
      }),
  );
};

/**
 * How long a claim on a decision holds. Longer than the unit budget
 * below, so a claim cannot lapse while its own fetch is still running,
 * and short enough that a worker killed mid-download only strands the
 * decision until the next queue pass.
 */
const CLAIM_TTL_SECONDS = 120;

/**
 * Claim a decision for one fetch attempt, or report that another worker
 * already holds it.
 *
 * The in-process single-flight map cannot see other API replicas or the
 * scheduler, and every duplicate is a download the source did not need
 * to serve. The claim is durable — `document_fetch_attempted_at`, read
 * and written in one statement — and the transaction-scoped advisory
 * try-lock keeps two claims from interleaving around that statement
 * without either of them waiting on a row lock.
 *
 * Claiming also counts the attempt, before the attempt is made, so a
 * worker that dies mid-download still leaves a record of having tried.
 */
/**
 * A won claim carries the decision snapshot read by the atomic update.
 * The store pins that hash, so a source refresh landing mid-fetch takes
 * the store out of scope rather than being overwritten by a document
 * parsed from what the source used to say.
 */
export type DocumentFetchClaim =
  | {
      status: "claimed";
      decision: ClaimedPendingDocument;
      /** Attempts counted so far, this one included. */
      attempts: number;
    }
  | { status: "held" };

const claimDocumentFetchOwned = async ({
  decisionId,
  fence,
  attemptPolicy,
}: {
  decisionId: SafeId<"caseLawDecision">;
  fence: DeferredDocumentSourceFence;
  attemptPolicy: "count" | "reserve-final-attempt";
}): Promise<DocumentFetchClaim> =>
  await fence.scopedDb(async (tx) => {
    const lockResult: unknown = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('case_law'), hashtext(${decisionId})) AS locked`,
    );
    const lockRow = executedRows(lockResult).at(0);
    if (!isRecord(lockRow) || lockRow["locked"] !== true) {
      return { status: "held" };
    }

    const previous = (
      await tx
        .select({ attempts: caseLawDecisions.documentFetchAttempts })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .limit(1)
    ).at(0);
    if (previous === undefined) {
      return { status: "held" };
    }
    const nextAttempts = previous.attempts + 1;
    // Ownership loss leaves the final attempt retryable. Its verdict commits
    // the ceiling only while the same source owner still holds the write.
    const countedAttempts =
      attemptPolicy === "reserve-final-attempt"
        ? Math.max(
            previous.attempts,
            Math.min(nextAttempts, MAX_DOCUMENT_FETCH_ATTEMPTS - 1),
          )
        : nextAttempts;
    // An attempt preserves the decision's public freshness timestamp.
    // audit: skip — public case-law document fetch; no user action
    const claimedRow = (
      await tx
        .update(caseLawDecisions)
        .set({
          documentFetchAttemptedAt: sql`now()`,
          documentFetchAttempts: countedAttempts,
          updatedAt: sql`${caseLawDecisions.updatedAt}`,
        })
        .where(
          and(
            eq(caseLawDecisions.id, decisionId),
            eq(caseLawDecisions.sourceId, fence.sourceId),
            isNull(caseLawDecisions.redactedAt),
            isNull(caseLawDecisions.fulltext),
            or(
              isNull(caseLawDecisions.documentFetchAttemptedAt),
              sql`${caseLawDecisions.documentFetchAttemptedAt} < now() - ${`${CLAIM_TTL_SECONDS} seconds`}::interval`,
            ),
          ),
        )
        .returning({
          ...PENDING_DOCUMENT_COLUMNS,
          sourceHash: caseLawDecisions.sourceHash,
        })
    ).at(0);
    if (claimedRow === undefined) {
      return { status: "held" };
    }
    const snapshot = claimedRow;
    return {
      status: "claimed",
      decision: {
        ...snapshot,
        attempts: nextAttempts,
        [claimedPendingDocument]: true,
      },
      attempts: nextAttempts,
    };
  });

/** A write decided by one claimed fetch of one decision. */
type ClaimedFetchWriteOptions = {
  decision: ClaimedPendingDocument;
  scopedDb: ScopedDb;
};

/**
 * Mark a decision whose PDF cannot be parsed, so the queue does not
 * hand back the same failure forever. An empty string is the pipeline's
 * existing "tried and got nothing" marker, distinct from NULL.
 *
 * Conditional on the row still being empty, so a fetch that came back
 * with nothing cannot erase a document another fetch of the same
 * decision has already stored. Empty means empty everywhere: this write
 * clears the corpus pointers along with the text, and a parse that
 * outlives its 120s claim can land after a retry has already stored the
 * document, so under canonical storage — where a stored document leaves
 * the text column null — the corpus state is the only thing standing
 * between a late failure and an unreachable payload. It is also
 * conditional on the source version the fetch was claimed on: a refresh
 * that pointed the row at a new document mid-fetch leaves it pending.
 */
const markDocumentUnavailableOwned = async ({
  decision,
  fence,
}: Omit<ClaimedFetchWriteOptions, "scopedDb"> & {
  fence: DeferredDocumentSourceFence;
}): Promise<void> => {
  const { scopedDb } = fence;
  await scopedDb(async (tx) => {
    const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, {
      family: "case_law",
      entityId: decision.id,
    });
    // audit: skip — queue backfill of public case-law text; no user action
    const updated = await tx
      .update(caseLawDecisions)
      .set({
        fulltext: "",
        documentFetchAttempts: sql`greatest(${caseLawDecisions.documentFetchAttempts}, ${decision.attempts}::int)`,
        ...corpusMirrorColumns({
          status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
          written: null,
        }),
      })
      .where(
        and(
          eq(caseLawDecisions.id, decision.id),
          eq(caseLawDecisions.sourceId, fence.sourceId),
          isNull(caseLawDecisions.redactedAt),
          isNull(caseLawDecisions.fulltext),
          storesNoCorpusDocument,
          holdsClaimedSource(decision.sourceHash),
        ),
      )
      .returning({ id: caseLawDecisions.id });
    if (updated.length > 0 && projectionLock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: projectionLock,
        subject: { family: "case_law", entityId: decision.id },
      });
    }
  });
};

/**
 * Take a decision out of the walk now rather than after its remaining
 * attempts. For a download the parser cannot read: fetching the same bytes
 * again would cost the publisher a request per cooldown and read no better,
 * while a parser fix is exactly what `requeueParkedDocuments` is for.
 * Fenced on the claimed source version like `markDocumentUnavailable`, so
 * unreadable bytes from before a refresh cannot park the refreshed row.
 */
const parkDocumentFetchOwned = async ({
  decision,
  fence,
}: Omit<ClaimedFetchWriteOptions, "scopedDb"> & {
  fence: DeferredDocumentSourceFence;
}): Promise<"parked" | "superseded"> => {
  const { scopedDb } = fence;
  const parked = await scopedDb(
    async (tx) =>
      await writeFetchBookkeeping(tx, {
        set: {
          documentFetchAttempts: sql`greatest(${caseLawDecisions.documentFetchAttempts}, ${MAX_DOCUMENT_FETCH_ATTEMPTS}::int)`,
        },
        where: and(
          eq(caseLawDecisions.id, decision.id),
          eq(caseLawDecisions.sourceId, fence.sourceId),
          isNull(caseLawDecisions.redactedAt),
          isNull(caseLawDecisions.fulltext),
          holdsClaimedSource(decision.sourceHash),
        ),
      }),
  );
  return parked.length > 0 ? "parked" : "superseded";
};

/**
 * The source's parked decisions.
 *
 * The pending backlog may greatly exceed the parked set, so both parked
 * reads below must come from
 * `case_law_decisions_document_parked_idx` (source, id) rather than from the
 * pending index; `parkedDocumentPredicate` is written so the planner can
 * match it. Exported as statement builders so the query-plan test explains
 * the same SQL these functions run.
 */
const parkedDocumentsOf = (sourceId: SafeId<"caseLawSource">) =>
  and(eq(caseLawDecisions.sourceId, sourceId), parkedDocumentPredicate);

/** Exact parked count for the manual requeue report. */
export const parkedDocumentCountQuery = (
  tx: Transaction,
  sourceId: SafeId<"caseLawSource">,
) =>
  // sql-perf-allow: index case_law_decisions_document_parked_idx; exact parked count runs once per manual requeue-sk-documents invocation.
  tx
    .select({ parked: sql<number>`count(*)::int` })
    .from(caseLawDecisions)
    .where(parkedDocumentsOf(sourceId));

/**
 * The first `limit` parked decisions in id order: an ordered range of the
 * parked index, stopped by the limit. A requeue resets the attempt count,
 * which takes a row out of that index, so the next call's head is the next
 * parked id without a cursor.
 */
export const parkedDocumentIdsQuery = ({
  limit,
  sourceId,
  tx,
}: {
  limit: number;
  sourceId: SafeId<"caseLawSource">;
  tx: Transaction;
}) =>
  tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(parkedDocumentsOf(sourceId))
    .orderBy(asc(caseLawDecisions.id))
    .limit(limit);

/** Parked decisions of the deferred-document source. */
export const countParkedDocuments = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
): Promise<number> => {
  const [row] = await scopedDb(
    async (tx) => await parkedDocumentCountQuery(tx, sourceId),
  );
  return row?.parked ?? 0;
};

/** Decisions one requeue resets at most, so its one statement stays bounded. */
export const MAX_REQUEUE_PARKED_DOCUMENTS = 5000;

export type RequeueParkedDocumentsOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  /** Decisions requeued by this call at most: 1 to `MAX_REQUEUE_PARKED_DOCUMENTS`. */
  limit: number;
};

/**
 * Put up to `limit` parked decisions back into the walk.
 *
 * The attempt count is what parks a decision, so resetting it is the whole
 * requeue; the last attempt's timestamp stays, so a requeued decision still
 * waits out one base cooldown rather than arriving at the head of the queue
 * in a burst. Returns how many were requeued.
 */
export const requeueParkedDocuments = async ({
  limit,
  scopedDb,
  sourceId,
}: RequeueParkedDocumentsOptions): Promise<number> => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_REQUEUE_PARKED_DOCUMENTS
  ) {
    return panic(
      `requeue limit must be an integer from 1 to ${MAX_REQUEUE_PARKED_DOCUMENTS}, got ${limit}`,
    );
  }
  return await scopedDb(async (tx) => {
    const parked = parkedDocumentIdsQuery({ limit, sourceId, tx });
    const requeued = await writeFetchBookkeeping(tx, {
      set: { documentFetchAttempts: 0 },
      where: inArray(caseLawDecisions.id, parked),
    });
    return requeued.length;
  });
};

/**
 * Outcomes of one document fetch: the document, a decision the source
 * has nothing readable for, a decision another worker is already
 * fetching, or this decision's own failure.
 *
 * A failure that is the decision's own comes back as an outcome rather
 * than a throw, because the caller's only answer to a throw is to slow
 * down, and one document the source keeps refusing must not slow the
 * walk for every document behind it. What still throws is what may affect
 * every document at once: the database, a publisher that is unreachable,
 * failing or refusing this client, a body that is not a PDF, and a parse
 * failure libpdf does not attribute to the bytes.
 */
export type DecisionDocumentOutcome =
  | { status: "filled"; document: BackfilledDocument }
  | { status: "unavailable" }
  | { status: "claimed" }
  | DeferredDocumentOwnershipRefusal
  /** The source moved mid-fetch; the queue's next pass fetches the current version. */
  | { status: "superseded" }
  /** This decision failed; it comes back after its own cooldown. */
  | { status: "deferred"; failure: DocumentFetchFailure; detail: string }
  /** This decision failed and has left the walk until it is requeued. */
  | { status: "parked"; failure: DocumentFetchFailure; detail: string };

/**
 * Wall-clock budget for the whole unit. The download has its own
 * timeout and honours the abort signal, but parsing a PDF does not: it
 * is CPU-bound and cannot be cancelled, so a pathological document
 * would otherwise run unbounded inside whichever path called this. The
 * race abandons the work rather than aborting it — the unit is
 * idempotent, so the abandoned attempt either lands or is retried.
 */
export const DOCUMENT_FETCH_BUDGET_MS = 60_000;

export type FetchDecisionDocumentOptions = {
  onDocumentObservation?: DocumentStageObserver | undefined;
  decisionId: SafeId<"caseLawDecision">;
  /** The publisher's gate, supplied by the caller. See `SkDocumentFetch`. */
  fetchDocument: SkDocumentFetch;
  scopedDb: ScopedDb;
  signal: AbortSignal;
};

type ParseFetchedDocumentOptions = {
  decision: ClaimedPendingDocument;
  bytes: Uint8Array;
  fence: DeferredDocumentSourceFence;
};

/**
 * Throw for a body that is not a PDF: a publisher serving an error page serves
 * it for every download, so the walk backs off rather than parking each one.
 */
const assertPdfBody = (bytes: Uint8Array): void => {
  if (declaredMimeMatchesMagic(PDF_MIME_TYPE, bytes)) {
    return;
  }
  const error = new SkDocumentNonPdfError({
    message: "Document fetch returned a body that is not a PDF",
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    cursor: null,
  });
  logger.warn(
    "case_law.ingestion.sk_document_parse_failed",
    skDocumentErrorDiagnostics(error),
  );
  throw error;
};

type ParseFetchedDocumentResult =
  | { type: "parsed"; document: BackfilledDocument | undefined }
  | { type: "parked"; detail: string }
  /** The source moved mid-fetch, so these bytes judge nothing. */
  | { type: "superseded" };

/**
 * Parse a download, parking the decision when libpdf reports that these
 * bytes are a PDF it cannot read: the one parse failure known to belong to
 * the document. Anything else the parse throws (the parser, the sanitizer,
 * segmentation) would fail the same way for every document, so it
 * propagates and the walk backs off instead of parking each decision it
 * reaches. A body that is not a PDF at all throws for the same reason: a
 * publisher serving an error page serves it for every download.
 */
const parseFetchedDocument = async ({
  bytes,
  decision,
  fence,
}: ParseFetchedDocumentOptions): Promise<ParseFetchedDocumentResult> => {
  assertPdfBody(bytes);
  const parsed = await Result.tryPromise({
    try: async () => await parsePendingDocument(decision, bytes),
    catch: (error) => error,
  });
  if (Result.isOk(parsed)) {
    return { type: "parsed", document: parsed.value };
  }
  if (!isUnreadablePdfError(parsed.error)) {
    throw parsed.error;
  }
  const parked = await parkDocumentFetchOwned({
    decision,
    fence,
  });
  return parked === "parked"
    ? { type: "parked", detail: errorTag(parsed.error) }
    : { type: "superseded" };
};

const runDecisionDocumentFetch = async ({
  decisionId,
  fetchDocument,
  scopedDb,
  signal,
  fence,
}: FetchDecisionDocumentOptions & {
  fence: DeferredDocumentSourceFence;
}): Promise<DecisionDocumentOutcome> => {
  const claim = await claimDocumentFetchOwned({
    decisionId,
    fence,
    attemptPolicy: "reserve-final-attempt",
  });
  if (claim.status === "held") {
    return { status: "claimed" };
  }

  const result = await Result.tryPromise({
    try: async () =>
      await processClaimedDocument({
        claim,
        fetchDocument,
        signal,
        fence,
      }),
    catch: (error) => error,
  });
  if (
    Result.isError(result) &&
    (isDeferredDocumentOwnershipLost(result.error) || signal.aborted)
  ) {
    throw result.error;
  }
  if (
    claim.attempts >= MAX_DOCUMENT_FETCH_ATTEMPTS &&
    (Result.isError(result) ||
      (result.value.status !== "filled" &&
        result.value.status !== "unavailable"))
  ) {
    await scopedDb(
      async (tx) =>
        await writeFetchBookkeeping(tx, {
          set: {
            documentFetchAttempts: sql`greatest(${caseLawDecisions.documentFetchAttempts}, ${claim.attempts}::int)`,
          },
          where: and(
            eq(caseLawDecisions.id, claim.decision.id),
            eq(caseLawDecisions.sourceId, fence.sourceId),
            holdsClaimedSource(claim.decision.sourceHash),
          ),
        }),
    );
  }
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

type SettleFetchedDocumentOptions = {
  attempts: number;
  decision: ClaimedPendingDocument;
  fetched: PdfFetchResult;
  fence: DeferredDocumentSourceFence;
};

type SettledFetchedDocument =
  | ParseFetchedDocumentResult
  /** The download ended the attempt without bytes to parse. */
  | { type: "settled"; outcome: DecisionDocumentOutcome };

/**
 * What a download leaves to parse. A PDF over the ceiling parks the decision
 * at once: asking again returns the same body, and nothing of it is stored.
 * An oversized body that is not a PDF throws as any non-PDF body does.
 */
const settleFetchedDocument = async ({
  attempts,
  decision,
  fetched,
  fence,
}: SettleFetchedDocumentOptions): Promise<SettledFetchedDocument> => {
  switch (fetched.type) {
    case "document":
      return await parseFetchedDocument({
        bytes: fetched.bytes,
        decision,
        fence,
      });
    case "absent":
      return { type: "parsed", document: undefined };
    case "failed": {
      const { failure, detail } = fetched;
      return {
        type: "settled",
        outcome:
          attempts >= MAX_DOCUMENT_FETCH_ATTEMPTS
            ? { status: "parked", failure, detail }
            : { status: "deferred", failure, detail },
      };
    }
    case "too-large": {
      if (fetched.prefix !== null) {
        assertPdfBody(fetched.prefix);
      }
      const parked = await parkDocumentFetchOwned({
        decision,
        fence,
      });
      return {
        type: "settled",
        outcome:
          parked === "parked"
            ? {
                status: "parked",
                failure: DOCUMENT_FETCH_FAILURE.TOO_LARGE,
                detail: `over-${fetched.limitBytes}-bytes`,
              }
            : { status: "superseded" },
      };
    }
    default:
      fetched satisfies never;
      return panic(`Unhandled document download: ${String(fetched)}`);
  }
};

type ProcessClaimedDocumentOptions = {
  claim: Extract<DocumentFetchClaim, { status: "claimed" }>;
  fetchDocument: SkDocumentFetch;
  signal: AbortSignal;
  fence: DeferredDocumentSourceFence;
};

const processClaimedDocument = async ({
  claim,
  fetchDocument,
  signal,
  fence,
}: ProcessClaimedDocumentOptions): Promise<DecisionDocumentOutcome> => {
  const { decision } = claim;
  const { documentUrl } = decision;
  const fetched: PdfFetchResult = documentUrl
    ? await fence.beforeRemoteEffect(
        async () =>
          await fetchPdfBytes({
            documentUrl,
            fetchDocument,
            signal,
          }),
      )
    : { type: "absent" };

  const parsed = await settleFetchedDocument({
    attempts: claim.attempts,
    decision,
    fetched,
    fence,
  });
  switch (parsed.type) {
    case "parsed":
      break;
    case "parked":
      return {
        status: "parked",
        failure: DOCUMENT_FETCH_FAILURE.UNPARSEABLE,
        detail: parsed.detail,
      };
    case "superseded":
      return { status: "superseded" };
    case "settled":
      return parsed.outcome;
    default:
      parsed satisfies never;
      return panic(`Unhandled parse result: ${String(parsed)}`);
  }

  const { document } = parsed;
  if (!document) {
    await markDocumentUnavailableOwned({
      decision,
      fence,
    });
    return { status: "unavailable" };
  }

  const stored = await storeBackfilledDocumentOwned({
    decision,
    document,

    fence,
  });
  if (stored === "superseded") {
    return { status: "superseded" };
  }
  return { status: "filled", document };
};

type OwnedDocumentOperationOptions<T> = {
  missingValue: NoInfer<T>;
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  signal?: AbortSignal;
  operation: (fence: DeferredDocumentSourceFence) => Promise<T>;
};

const ownedDocumentOperation = async <T>(
  options: OwnedDocumentOperationOptions<T>,
): Promise<T | DeferredDocumentOwnershipRefusal> => {
  const result = await withDeferredDocumentSourceOwnership({
    ...options,
    timeoutMs: DOCUMENT_FETCH_BUDGET_MS,
  });
  if (result.status === "missing") {
    return options.missingValue;
  }
  return result.status === "completed" ? result.value : result;
};

/**
 * Fetch, parse and persist one decision's document.
 *
 * The single unit of work behind both the queue and the read-through
 * path, so a decision reaches the same durable state whichever one gets
 * to it: the claim counts the attempt first, the parse either produces
 * the document or marks it unavailable, and the store is conditional on
 * the row still being empty. Running it twice therefore converges. A
 * failure of this decision alone leaves `fulltext` NULL and returns
 * `deferred`, or `parked` once its attempts run out; a failure that may
 * affect every decision throws. The claim has counted the attempt either
 * way, so a decision that keeps throwing still reaches its longer
 * cooldowns and, in the end, the parking threshold.
 */
export const fetchDecisionDocument = async (
  options: FetchDecisionDocumentOptions,
): Promise<DecisionDocumentOutcome> =>
  await withDocumentStageObserver({
    source: ADAPTER_KEYS.SK_COURTS,
    observe: options.onDocumentObservation,
    execute: async () =>
      await ownedDocumentOperation({
        missingValue: { status: "superseded" } as const,
        decisionId: options.decisionId,
        scopedDb: options.scopedDb,
        signal: options.signal,
        operation: async (fence) =>
          await runDecisionDocumentFetch({
            ...options,
            scopedDb: fence.scopedDb,
            signal: fence.signal,
            fence,
          }),
      }),
    outcome: (result) => {
      switch (result.status) {
        case "filled":
        case "unavailable":
        case "claimed":
        case "superseded":
        case "busy":
        case "lost":
          return DOCUMENT_FETCH_OUTCOME.ok;
        case "deferred":
        case "parked": {
          const outcomes = {
            [DOCUMENT_FETCH_FAILURE.PUBLISHER_STATUS]:
              DOCUMENT_FETCH_OUTCOME.http4xx,
            [DOCUMENT_FETCH_FAILURE.NETWORK]: DOCUMENT_FETCH_OUTCOME.connection,
            [DOCUMENT_FETCH_FAILURE.UNPARSEABLE]:
              DOCUMENT_FETCH_OUTCOME.bodyShape,
            [DOCUMENT_FETCH_FAILURE.TOO_LARGE]:
              DOCUMENT_FETCH_OUTCOME.bodyShape,
          } as const satisfies Record<
            DocumentFetchFailure,
            DocumentFetchOutcome
          >;
          return outcomes[result.failure];
        }
        default:
          result satisfies never;
          return panic(`Unhandled document outcome: ${String(result)}`);
      }
    },
  });

export const claimDocumentFetch = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<DocumentFetchClaim | DeferredDocumentOwnershipRefusal> =>
  await ownedDocumentOperation({
    missingValue: { status: "held" } as const,
    decisionId,
    scopedDb,
    operation: async (fence) =>
      await claimDocumentFetchOwned({
        decisionId,
        fence,
        attemptPolicy: "count",
      }),
  });

export const storeBackfilledDocument = async (
  options: StoreBackfilledDocumentOptions,
) =>
  await ownedDocumentOperation({
    missingValue: "superseded" as const,
    decisionId: options.decision.id,
    scopedDb: options.scopedDb,
    operation: async (fence) =>
      await storeBackfilledDocumentOwned({
        ...options,
        fence,
      }),
  });

export const markDocumentUnavailable = async (
  options: ClaimedFetchWriteOptions,
) =>
  await ownedDocumentOperation({
    missingValue: undefined,
    decisionId: options.decision.id,
    scopedDb: options.scopedDb,
    operation: async (fence) =>
      await markDocumentUnavailableOwned({
        ...options,
        fence,
      }),
  });

export const parkDocumentFetch = async (options: ClaimedFetchWriteOptions) =>
  await ownedDocumentOperation({
    missingValue: "superseded" as const,
    decisionId: options.decision.id,
    scopedDb: options.scopedDb,
    operation: async (fence) =>
      await parkDocumentFetchOwned({
        ...options,
        fence,
      }),
  });
