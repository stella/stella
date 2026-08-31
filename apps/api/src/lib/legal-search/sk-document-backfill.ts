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

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type DocumentAst,
  isDocumentAst,
} from "@/api/lib/case-law/document-ast";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { fetchWithTimeout } from "@/api/lib/fetch";
import {
  reserveCaseLawCorpusUploadIntent,
  writeReservedCaseLawCorpusUpload,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { indexDecision } from "@/api/lib/legal-search/case-law-search-index";
import {
  type ActiveCorpusProjectionSourceLock,
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  corpusContentHash,
  corpusMirrorColumns,
  corpusPayloadDisposition,
  EMPTY_CORPUS_CONTENT_HASHES,
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
  writeCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  CorpusPayloadColumns,
  WriteCorpusResult,
} from "@/api/lib/legal-search/corpus-storage";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { parseSkDecisionPdf } from "@/api/lib/legal-search/parsers/sk-courts";
import { segmentDecision } from "@/api/lib/legal-search/segment-decision";
import { restrictSkCourtDocumentUrl } from "@/api/lib/legal-search/sk-court-document-url";
import type { PendingDocumentTierLoaders } from "@/api/lib/legal-search/sk-document-queue";
import { isRecord } from "@/api/lib/type-guards";
import { withTimeout } from "@/api/lib/with-timeout";

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

/**
 * PDFs are large and the court's site is slow; this is the timeout the
 * adapter used before the download was deferred.
 */
const PDF_TIMEOUT_MS = 30_000;

export const fetchPdfBytes = async (
  documentUrl: string,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> => {
  const target = restrictSkCourtDocumentUrl(documentUrl);
  if (target === null) {
    // Persisted legacy rows can predate the provider boundary. Returning the
    // terminal unavailable outcome lets the caller drain them from the queue;
    // retrying cannot make an off-origin URL become trusted.
    return undefined;
  }

  const response = await fetchWithTimeout(target, {
    redirect: "error",
    signal,
    timeoutMs: PDF_TIMEOUT_MS,
  });
  if (response.ok) {
    return new Uint8Array(await response.arrayBuffer());
  }
  // Only a response that says the document does not exist proves
  // unavailability. Anything else (5xx, 429, auth hiccups) is transient:
  // throw, so the row keeps a NULL fulltext and stays in the queue for a
  // later attempt instead of being marked unavailable forever.
  if (response.status === 404 || response.status === 410) {
    return undefined;
  }
  throw new AdapterFetchError({
    message: `Document fetch returned ${response.status}`,
    adapterKey: ADAPTER_KEYS.SK_COURTS,
    cursor: null,
    httpStatus: response.status,
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
 * How long the queue leaves a decision alone after an attempt.
 *
 * Failures here are usually the source's, not this decision's: a court
 * site that answers 403 for one document answers it for the next forty
 * too. Without a cooldown the head of the queue would be re-attempted
 * every run and nothing behind it would ever be reached. Far longer
 * than the claim's own TTL, which only guards one fetch in flight; a
 * reader who opens the decision again is not held by this, because the
 * read-through claims directly.
 */
const FETCH_COOLDOWN_HOURS = 6;

const outsideFetchCooldown = or(
  isNull(caseLawDecisions.documentFetchAttemptedAt),
  lt(
    caseLawDecisions.documentFetchAttemptedAt,
    sql`now() - ${`${FETCH_COOLDOWN_HOURS} hours`}::interval`,
  ),
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
 * The hash test is a residual filter: the partial indexes behind the two
 * tiers are predicated on the text column and the document URL only,
 * because an index predicate would have to spell the hashes out as
 * literals and could then drift from these. Under the deployed storage
 * mode nothing carries a hash, so the filter costs nothing; a canonical
 * cutover should revisit it, since a fully drained corpus would leave
 * the scan walking trimmed rows to conclude the queue is empty.
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
export const storesNoCorpusDocument = or(
  isNull(caseLawDecisions.contentHash),
  inArray(caseLawDecisions.contentHash, [...EMPTY_CORPUS_CONTENT_HASHES]),
  isNotNull(caseLawDecisions.documentAst),
);

export const pendingDocumentPredicate = and(
  isNull(caseLawDecisions.redactedAt),
  isNull(caseLawDecisions.fulltext),
  isNotNull(caseLawDecisions.documentUrl),
  storesNoCorpusDocument,
);

/** Pending, asked for by a reader, and still within its retry budget. */
export const requestedDocumentPredicate = and(
  pendingDocumentPredicate,
  outsideFetchCooldown,
  isNotNull(caseLawDecisions.documentFetchRequestedAt),
  lt(caseLawDecisions.documentFetchAttempts, MAX_PRIORITY_FETCH_ATTEMPTS),
);

/** Everything else: never asked for, or asked for and out of retries. */
export const remainingDocumentPredicate = and(
  pendingDocumentPredicate,
  outsideFetchCooldown,
  or(
    isNull(caseLawDecisions.documentFetchRequestedAt),
    gte(caseLawDecisions.documentFetchAttempts, MAX_PRIORITY_FETCH_ATTEMPTS),
  ),
);

/** Oldest request first, so a reader waits for one drain at most. */
export const requestedDocumentOrder = [
  asc(caseLawDecisions.documentFetchRequestedAt),
  asc(caseLawDecisions.id),
] as const;

/**
 * Least-tried first, then newest decision. Attempts lead so a document
 * the source keeps refusing sinks below everything still untried rather
 * than holding the newest end of the range; within one attempt count the
 * newest decision is the one a reader is most likely to open next.
 * NULLS LAST matches the index and puts undated decisions after every
 * dated one, rather than at the head of a DESC scan.
 */
export const remainingDocumentOrder = [
  asc(caseLawDecisions.documentFetchAttempts),
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

/** Keyset position in the remaining tier (attempts, decisionDate, id). */
export type RemainingDocumentCursor = {
  attempts: number;
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
 * Keyset boundary within one attempt count, for `decision_date DESC
 * NULLS LAST, id ASC`. A NULL date sorts after every date, so a cursor
 * on a dated row also has to admit the undated tail, and a cursor
 * already in that tail is ordered by id alone.
 */
const remainingDateCursorPredicate = ({
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
 * Keyset boundary for `attempts ASC, decision_date DESC NULLS LAST, id
 * ASC`: everything in a later attempt count, plus what follows the
 * cursor inside its own.
 */
const remainingCursorPredicate = (cursor: RemainingDocumentCursor) =>
  or(
    gt(caseLawDecisions.documentFetchAttempts, cursor.attempts),
    and(
      eq(caseLawDecisions.documentFetchAttempts, cursor.attempts),
      remainingDateCursorPredicate(cursor),
    ),
  );

/**
 * Remaining tier: newest decision first. A fresh decision is the one a
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

  const resolveSourceId = async (): Promise<
    SafeId<"caseLawSource"> | undefined
  > => {
    sourceId ??= await loadDeferredDocumentSourceId(scopedDb);
    return sourceId;
  };

  return {
    loadRequested: async (limit) => {
      const id = await resolveSourceId();
      return id === undefined
        ? []
        : await loadRequestedDocuments({ scopedDb, sourceId: id, limit });
    },
    loadRemaining: async (limit) => {
      const id = await resolveSourceId();
      return id === undefined
        ? []
        : await loadRemainingDocuments({ scopedDb, sourceId: id, limit });
    },
  };
};

/**
 * One page of the queue: decisions a reader asked for first, then the
 * newest of the rest. Both tiers are keyset-ordered against a partial
 * index and bounded by `limit`, so neither scans the backlog. The
 * worker walks the same two tiers as a stream; see
 * `sk-document-queue.ts`.
 */
export const loadPendingDocuments = async (
  scopedDb: ScopedDb,
  limit: number,
): Promise<PendingDocument[]> => {
  const { loadRemaining, loadRequested } =
    scopedPendingDocumentTierLoaders(scopedDb);

  const requested = await loadRequested(limit);
  if (requested.length >= limit) {
    return requested;
  }

  const remaining = await loadRemaining(limit - requested.length);
  return [...requested, ...remaining];
};

/**
 * The corpus writer this store uses, or null where corpus storage is
 * off and the Postgres columns are the whole of it.
 */
export const corpusDocumentWriter = (): typeof writeCorpusDocument | null =>
  corpusStorageMode === "off" ? null : writeCorpusDocument;

export type StoreBackfilledDocumentOptions = {
  decision: PendingDocument;
  document: BackfilledDocument;
  scopedDb: ScopedDb;
  /**
   * Seam for tests, which drive the corpus path without a bucket and
   * without depending on which module happened to read the environment
   * first. Production passes nothing.
   */
  writeCorpus?: typeof writeCorpusDocument | null;
  /**
   * Storage mode this store settles under. Production passes nothing;
   * tests set it for the same reason they inject the writer, so the
   * canonical path is exercised without depending on which module read
   * the environment first.
   */
  mode?: CorpusStorageMode;
  /**
   * The row's source hash when the fetch was claimed. The store applies
   * only while it still holds: a source refresh that lands mid-fetch has
   * rewritten the decision this document was parsed for, so the document
   * is dropped and the queue fetches it again against the new state.
   * Omitted by callers with no claim of their own (the repair scripts).
   */
  claimedSourceHash?: string | null;
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
export const storeBackfilledDocument = async ({
  decision,
  document,
  scopedDb,
  writeCorpus = corpusDocumentWriter(),
  mode = corpusStorageMode,
  claimedSourceHash,
}: StoreBackfilledDocumentOptions): Promise<"stored" | "superseded"> => {
  const sections = document.sections.length > 0 ? document.sections : null;
  const payload = {
    documentId: decision.id,
    jurisdiction: decision.country,
    text: document.fulltext,
    sections,
    ast: document.documentAst,
  };
  const ownerPredicate = and(
    eq(caseLawDecisions.id, decision.id),
    isNull(caseLawDecisions.redactedAt),
    sql`coalesce(${caseLawDecisions.fulltext}, '') = ''`,
    // The text column stops being the whole answer once a canonical store
    // nulls it: without this, a store whose parse outlived its claim would
    // read a decision another attempt already filled as still empty and
    // overwrite it.
    storesNoCorpusDocument,
    claimedSourceHash === undefined
      ? undefined
      : sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${claimedSourceHash}`,
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
  if (writeCorpus === null) {
    stored = await scopedDb(async (tx) => {
      const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, {
        family: "case_law",
        entityId: decision.id,
      });
      return await applyStoredPayload(tx, null, projectionLock);
    });
  } else {
    const intent = await reserveCaseLawCorpusUploadIntent({
      contentHash: corpusContentHash(payload),
      decisionId: decision.id,
      jurisdiction: decision.country,
      scopedDb,
    });
    if (intent.type !== "reserved") {
      return "superseded";
    }
    const outcome = await writeReservedCaseLawCorpusUpload({
      apply: async ({ projectionLock, tx, written }) => ({
        type: (await applyStoredPayload(tx, written, projectionLock))
          ? "applied"
          : "superseded",
      }),
      decisionId: decision.id,
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
      write: async ({ signal }) =>
        await writeCorpus(
          {
            ...payload,
            // The queue admits only rows whose corpus stores no document
            // (`storesNoCorpusDocument`), so no recorded write can match
            // the fetched document's payload; there is nothing to compare.
            stored: null,
          },
          { signal },
        ),
    });
    stored = outcome.type === "applied";
  }

  await indexDecision(decision.id, scopedDb);
  // A missed compare-and-set is a superseded store, not a stored document:
  // the source moved while this fetch was in flight, and the queue's next
  // pass fetches the current version. Reporting it as stored would count a
  // document that is not there.
  return stored ? "stored" : "superseded";
};

/**
 * Record that a reader asked for this document. Only the first request
 * is kept: the queue orders by it, and refreshing the timestamp on every
 * view would send a popular decision to the back of its own tier.
 */
export const recordDocumentFetchRequest = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<void> => {
  await scopedDb(async (tx) => {
    // Raw statement for the same reason as the claim below: a request is
    // not a change to the decision, so `updated_at` stays where it is.
    // audit: skip — public case-law read-through; no user action
    await tx.execute(sql`
      UPDATE ${caseLawDecisions}
      SET document_fetch_requested_at = now()
      WHERE id = ${decisionId}
        AND redacted_at IS NULL
        AND document_fetch_requested_at IS NULL
    `);
  });
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
 * A won claim, carrying the source hash the row had when it was won.
 * The store pins that hash, so a source refresh landing mid-fetch takes
 * the store out of scope rather than being overwritten by a document
 * parsed from what the source used to say.
 */
export type DocumentFetchClaim =
  | { status: "claimed"; sourceHash: string | null }
  | { status: "held" };

export const claimDocumentFetch = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<DocumentFetchClaim> =>
  await scopedDb(async (tx) => {
    const lockResult: unknown = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('case_law'), hashtext(${decisionId})) AS locked`,
    );
    const lockRow: unknown = Array.isArray(lockResult)
      ? lockResult.at(0)
      : undefined;
    if (!isRecord(lockRow) || lockRow["locked"] !== true) {
      return { status: "held" };
    }

    // Raw statement rather than the query builder: the claim has to
    // read and write `document_fetch_attempted_at` in one round trip,
    // and it deliberately leaves `updated_at` alone — an attempt is not
    // a change to the decision, and the public reads key their
    // freshness off that column.
    // audit: skip — public case-law document fetch; no user action
    const claimed: unknown = await tx.execute(sql`
      UPDATE ${caseLawDecisions}
      SET document_fetch_attempted_at = now(),
          document_fetch_attempts = document_fetch_attempts + 1
      WHERE id = ${decisionId}
        AND redacted_at IS NULL
        AND fulltext IS NULL
        AND (
          document_fetch_attempted_at IS NULL
          OR document_fetch_attempted_at
             < now() - ${`${CLAIM_TTL_SECONDS} seconds`}::interval
        )
      RETURNING source_hash AS "sourceHash"
    `);

    const claimedRow: unknown = Array.isArray(claimed)
      ? claimed.at(0)
      : undefined;
    if (!isRecord(claimedRow)) {
      return { status: "held" };
    }

    const sourceHash = claimedRow["sourceHash"];
    return {
      status: "claimed",
      sourceHash: typeof sourceHash === "string" ? sourceHash : null,
    };
  });

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
 * between a late failure and an unreachable payload.
 */
export const markDocumentUnavailable = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<void> => {
  await scopedDb(async (tx) => {
    const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, {
      family: "case_law",
      entityId: decisionId,
    });
    // audit: skip — queue backfill of public case-law text; no user action
    const updated = await tx
      .update(caseLawDecisions)
      .set({
        fulltext: "",
        ...corpusMirrorColumns({
          status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
          written: null,
        }),
      })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          isNull(caseLawDecisions.redactedAt),
          isNull(caseLawDecisions.fulltext),
          storesNoCorpusDocument,
        ),
      )
      .returning({ id: caseLawDecisions.id });
    if (updated.length > 0 && projectionLock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: projectionLock,
        subject: { family: "case_law", entityId: decisionId },
      });
    }
  });
};

/**
 * Outcomes of one document fetch: the document, a decision the source
 * has nothing readable for, or a decision another worker is already
 * fetching.
 */
export type DecisionDocumentOutcome =
  | { status: "filled"; document: BackfilledDocument }
  | { status: "unavailable" }
  | { status: "claimed" }
  /** The source moved mid-fetch; the queue's next pass fetches the current version. */
  | { status: "superseded" };

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
  decision: PendingDocument;
  scopedDb: ScopedDb;
  signal: AbortSignal;
};

const runDecisionDocumentFetch = async ({
  decision,
  scopedDb,
  signal,
}: FetchDecisionDocumentOptions): Promise<DecisionDocumentOutcome> => {
  const claim = await claimDocumentFetch(decision.id, scopedDb);
  if (claim.status === "held") {
    return { status: "claimed" };
  }

  const pdfBytes = decision.documentUrl
    ? await fetchPdfBytes(decision.documentUrl, signal)
    : undefined;
  const document = pdfBytes
    ? await parsePendingDocument(decision, pdfBytes)
    : undefined;

  if (!document) {
    await markDocumentUnavailable(decision.id, scopedDb);
    return { status: "unavailable" };
  }

  const stored = await storeBackfilledDocument({
    decision,
    document,
    scopedDb,
    claimedSourceHash: claim.sourceHash,
  });
  if (stored === "superseded") {
    return { status: "superseded" };
  }
  return { status: "filled", document };
};

/**
 * Fetch, parse and persist one decision's document.
 *
 * The single unit of work behind both the queue and the read-through
 * path, so a decision reaches the same durable state whichever one gets
 * to it: the claim counts the attempt first, the parse either produces
 * the document or marks it unavailable, and the store is conditional on
 * the row still being empty. Running it twice therefore converges. A
 * transient failure throws and leaves `fulltext` NULL, which keeps the
 * decision in the queue for a later attempt.
 */
export const fetchDecisionDocument = async (
  options: FetchDecisionDocumentOptions,
): Promise<DecisionDocumentOutcome> =>
  await withTimeout(async () => await runDecisionDocumentFetch(options), {
    label: "caseLaw.fetchDecisionDocument",
    timeoutMs: DOCUMENT_FETCH_BUDGET_MS,
  });
