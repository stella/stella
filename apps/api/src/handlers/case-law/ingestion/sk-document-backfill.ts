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
 * Two callers share the per-decision unit below: this queue, and the
 * read path when a reader opens a decision the queue has not reached
 * (`decisions/document-on-demand.ts`). The queue therefore orders by
 * what readers have asked for before falling back to the newest
 * decisions, and the unit itself is idempotent, because either caller
 * may reach a decision first.
 */

import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import { ADAPTER_KEYS, PARSER_VERSION } from "@/api/handlers/case-law/consts";
import {
  type DocumentAst,
  isDocumentAst,
} from "@/api/handlers/case-law/document-ast";
import { parseSkDecisionPdf } from "@/api/handlers/case-law/ingestion/parsers/sk-courts";
import { sanitizeResult } from "@/api/handlers/case-law/ingestion/pipeline";
import { segmentDecision } from "@/api/handlers/case-law/ingestion/segmenter";
import { indexDecision } from "@/api/handlers/case-law/search-index";
import type { SafeId } from "@/api/lib/branded-types";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { isRecord } from "@/api/lib/type-guards";
import { withTimeout } from "@/api/lib/with-timeout";

/** A decision awaiting its document. */
export type PendingDocument = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  ecli: string | null;
  court: string;
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
  const response = await fetchWithTimeout(documentUrl, {
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
  throw new Error(`document fetch returned ${response.status}`);
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
  decisionDate: caseLawDecisions.decisionDate,
  decisionType: caseLawDecisions.decisionType,
  documentUrl: caseLawDecisions.documentUrl,
};

/**
 * A decision whose document has not been fetched yet: no text, and
 * something to fetch. An empty string is the "tried and got nothing"
 * marker and is deliberately not NULL, so it leaves the queue.
 */
export const pendingDocumentPredicate = and(
  isNull(caseLawDecisions.fulltext),
  isNotNull(caseLawDecisions.documentUrl),
);

/** Pending, asked for by a reader, and still within its retry budget. */
export const requestedDocumentPredicate = and(
  pendingDocumentPredicate,
  isNotNull(caseLawDecisions.documentFetchRequestedAt),
  lt(caseLawDecisions.documentFetchAttempts, MAX_PRIORITY_FETCH_ATTEMPTS),
);

/** Everything else: never asked for, or asked for and out of retries. */
export const remainingDocumentPredicate = and(
  pendingDocumentPredicate,
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
 * Newest decision first. NULLS LAST matches the index and puts undated
 * decisions after every dated one, rather than at the head of a DESC
 * scan.
 */
export const remainingDocumentOrder = [
  sql`${caseLawDecisions.decisionDate} desc nulls last`,
  asc(caseLawDecisions.id),
] as const;

/** Keyset position in the requested tier (requestedAt, id). */
export type RequestedDocumentCursor = {
  requestedAt: Date;
  id: SafeId<"caseLawDecision">;
};

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
        ? or(
            gt(caseLawDecisions.documentFetchRequestedAt, after.requestedAt),
            and(
              eq(caseLawDecisions.documentFetchRequestedAt, after.requestedAt),
              gt(caseLawDecisions.id, after.id),
            ),
          )
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
 * Load the head of the queue: decisions a reader asked for first, then
 * the newest of the rest. Both tiers are keyset-ordered against a
 * partial index and bounded by `limit`, so neither scans the backlog.
 */
export const loadPendingDocuments = async (
  scopedDb: ScopedDb,
  limit: number,
): Promise<PendingDocument[]> => {
  const sourceId = await loadDeferredDocumentSourceId(scopedDb);
  if (!sourceId) {
    return [];
  }

  const requested = await loadRequestedDocuments({
    scopedDb,
    sourceId,
    limit,
  });
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
 * Write a parsed document onto its decision and re-index it. Without
 * the re-index the row gains fulltext that search cannot see, which is
 * indistinguishable from the state this is fixing.
 *
 * The write is conditional on the row still having no text, so two
 * fetches of the same decision converge on one stored document instead
 * of the later writer overwriting the earlier one. The re-index runs
 * either way: it reads the stored row, so it is idempotent and it also
 * repairs a decision whose text landed but whose index write did not.
 */
export const storeBackfilledDocument = async (
  decisionId: SafeId<"caseLawDecision">,
  document: BackfilledDocument,
  scopedDb: ScopedDb,
): Promise<void> => {
  await scopedDb(async (tx) => {
    // audit: skip — scheduler backfill of public case-law text; no user action
    await tx
      .update(caseLawDecisions)
      .set({
        fulltext: document.fulltext,
        documentAst: document.documentAst,
        sections: document.sections.length > 0 ? document.sections : null,
        parserVersion: PARSER_VERSION,
      })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          sql`coalesce(${caseLawDecisions.fulltext}, '') = ''`,
        ),
      );
  });

  await indexDecision(decisionId, scopedDb);
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
export const claimDocumentFetch = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<boolean> =>
  await scopedDb(async (tx) => {
    const lockResult: unknown = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('case_law'), hashtext(${decisionId})) AS locked`,
    );
    const lockRow: unknown = Array.isArray(lockResult)
      ? lockResult.at(0)
      : undefined;
    if (!isRecord(lockRow) || lockRow["locked"] !== true) {
      return false;
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
        AND fulltext IS NULL
        AND (
          document_fetch_attempted_at IS NULL
          OR document_fetch_attempted_at
             < now() - ${`${CLAIM_TTL_SECONDS} seconds`}::interval
        )
      RETURNING id
    `);

    return Array.isArray(claimed) && claimed.length > 0;
  });

/**
 * Mark a decision whose PDF cannot be parsed, so the queue does not
 * hand back the same failure forever. An empty string is the pipeline's
 * existing "tried and got nothing" marker, distinct from NULL.
 *
 * Conditional on the row still being empty, so a fetch that came back
 * with nothing cannot erase a document another fetch of the same
 * decision has already stored.
 */
export const markDocumentUnavailable = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
): Promise<void> => {
  await scopedDb(async (tx) => {
    // audit: skip — scheduler backfill of public case-law text; no user action
    await tx
      .update(caseLawDecisions)
      .set({ fulltext: "" })
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          isNull(caseLawDecisions.fulltext),
        ),
      );
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
  | { status: "claimed" };

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
  if (!(await claimDocumentFetch(decision.id, scopedDb))) {
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

  await storeBackfilledDocument(decision.id, document, scopedDb);
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
