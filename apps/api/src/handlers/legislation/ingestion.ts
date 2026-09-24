import { panic, Result } from "better-result";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { createStatuteSlug } from "@stll/api-contract/statute-route";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import { restrictLegislationDocumentUrls } from "@/api/handlers/legislation/ingestion/outbound-urls";
import {
  defectiveJunctions,
  storedWindow,
} from "@/api/handlers/legislation/version-windows";
import type { StoredWindow } from "@/api/handlers/legislation/version-windows";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  sanitizeMetadata,
  stripDangerousChars,
} from "@/api/lib/legal-search/corpus-sanitize";
import {
  corpusContentHash,
  planCorpusDocumentWrite,
  storedCorpusWrite,
  writeCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type { CorpusWriteOutcome } from "@/api/lib/legal-search/corpus-storage";
import {
  canStartCyclePage,
  startCycleDeadline,
} from "@/api/lib/legal-search/cycle-deadline";
import {
  ADAPTER_TIMEOUT,
  MAX_CYCLE_MS,
  MAX_SYNC_PAGES,
} from "@/api/lib/legal-search/ingestion-constants";
import type { SliceCoverage } from "@/api/lib/legal-search/ingestion-types";
import type {
  LegislationDocumentInput,
  LegislationSourceAdapter,
} from "@/api/lib/legal-search/legislation-ingestion-types";
import {
  RAW_SOURCE_FAMILY,
  writeRawSourcePayload,
} from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";

/**
 * Legislation ingestion. The canonical, source-agnostic entry is
 * `processLegislationDocument` (store + upsert), which any source feeds;
 * `runLegislationIngestion` drives one `LegislationSourceAdapter` through it.
 * The substrate (object storage, corpus index, pg-fts projection, search,
 * erasure) is shared with case law via the `legislation` family, and so is
 * the adapter contract — see
 * `apps/api/src/lib/legal-search/legislation-ingestion-types.ts`.
 *
 * Sanitisation is pipeline-level (`sanitizeInput`), so adapters must not
 * sanitise. So is the outbound URL boundary (`restrictLegislationDocumentUrls`),
 * so adapters declare their origins and do not check them.
 */

/** What storing one legislation document produced. */
export type ProcessLegislationResult =
  | {
      type: "stored";
      id: SafeId<"legislationDocument">;
      inserted: boolean;
      skipped: boolean;
      /** Object-storage write failed; the row keeps its previous sourceHash so a re-ingest retries. */
      corpusWriteFailed: boolean;
    }
  | {
      /**
       * The publisher's payload could not be stored, so no row was
       * written either. Writing one would persist the new sourceHash without
       * its raw payload, and the dedup check would then skip this document
       * forever — losing the payload rather than retrying it.
       */
      type: "source-raw-write-failed";
    };

const sanitizeInput = (
  input: LegislationDocumentInput,
): LegislationDocumentInput => ({
  ...input,
  eli: stripDangerousChars(input.eli),
  title: stripDangerousChars(input.title),
  fulltext:
    input.fulltext === null || input.fulltext === undefined
      ? null
      : stripDangerousChars(input.fulltext),
  sourceRaw:
    input.sourceRaw === undefined
      ? undefined
      : stripDangerousChars(input.sourceRaw),
  metadata: sanitizeMetadata(input.metadata ?? {}),
});

type PreserveLegislationCorpusWriteRetryInput = {
  documentId: SafeId<"legislationDocument">;
  previousSourceHash: string | null;
  /** The sourceHash this run persisted; the reset only applies while the row still carries it. */
  expectedSourceHash: string | null;
  scopedDb: ScopedDb;
};

const preserveLegislationCorpusWriteRetry = async ({
  documentId,
  previousSourceHash,
  expectedSourceHash,
  scopedDb,
}: PreserveLegislationCorpusWriteRetryInput): Promise<void> => {
  // Keep the next ingestion pass from treating this document as unchanged
  // after a failed object-storage write. Clear corpus-derived pointers so
  // reads use the fresh Postgres columns until S3 succeeds.
  await scopedDb(async (tx) => {
    const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, {
      family: "legislation",
      entityId: documentId,
    });
    // audit: skip — background corpus storage retry bookkeeping; derived state
    const reset = (
      await tx
        .update(legislationDocuments)
        .set({
          sourceHash: previousSourceHash,
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
          contentHash: null,
        })
        // Only undo this run's own write: a concurrent newer refresh owns
        // the row once it has advanced sourceHash.
        .where(
          and(
            eq(legislationDocuments.id, documentId),
            sql`${legislationDocuments.sourceHash} IS NOT DISTINCT FROM ${expectedSourceHash}`,
          ),
        )
        .returning({ id: legislationDocuments.id })
    ).at(0);
    if (reset === undefined) {
      return;
    }
    if (projectionLock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: projectionLock,
        subject: { family: "legislation", entityId: documentId },
      });
    }
  });
};

type SettleLegislationCorpusProjectionInput = {
  documentId: SafeId<"legislationDocument">;
  expectedSourceHash: string;
  outcome: CorpusWriteOutcome | null;
  scopedDb: ScopedDb;
};

/** Settle corpus pointers and the matching desired projection as one CAS. */
const settleLegislationCorpusProjection = async ({
  documentId,
  expectedSourceHash,
  outcome,
  scopedDb,
}: SettleLegislationCorpusProjectionInput): Promise<boolean> =>
  await scopedDb(async (tx) => {
    const projectionLock = await lockActiveCorpusProjectionSourceTx(tx, {
      family: "legislation",
      entityId: documentId,
    });
    const ownerPredicate = and(
      eq(legislationDocuments.id, documentId),
      sql`${legislationDocuments.sourceHash} IS NOT DISTINCT FROM ${expectedSourceHash}`,
    );
    // audit: skip — background corpus pointer and projection settlement; derived state
    const owned =
      outcome === null || outcome.type === "skipped-unchanged"
        ? (
            await tx
              .select({ id: legislationDocuments.id })
              .from(legislationDocuments)
              .where(ownerPredicate)
              .limit(1)
              .for("update")
          ).at(0)
        : (
            await tx
              .update(legislationDocuments)
              .set({
                textS3Key: outcome.written?.textKey ?? null,
                normalizedS3Key: outcome.written?.sectionsKey ?? null,
                astS3Key: outcome.written?.astKey ?? null,
                contentHash:
                  outcome.type === "skipped-empty"
                    ? outcome.contentHash
                    : outcome.written.contentHash,
              })
              .where(ownerPredicate)
              .returning({ id: legislationDocuments.id })
          ).at(0);
    if (owned === undefined) {
      return false;
    }
    if (projectionLock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: projectionLock,
        subject: { family: "legislation", entityId: documentId },
      });
    }
    return true;
  });

/**
 * Hash over every persisted, search-visible field — not just the corpus
 * payload — so a source re-emitting identical text with changed metadata
 * (title, status, dates, URLs) still updates the row instead of hitting
 * the dedup skip.
 *
 * `rawHash` is in it for the opposite reason: a publisher may change
 * something this parser does not yet read, and without the observation
 * fingerprint that change hashes identically and the row can never be
 * refreshed once a later parser learns to read it.
 */
const legislationSourceHash = (
  input: LegislationDocumentInput,
  window: StoredWindow,
): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify([
      input.eli,
      input.title,
      input.country,
      input.language,
      input.documentType ?? null,
      input.status ?? "current",
      input.effectiveDate ?? null,
      // The stored bounds, not the declaration: a connector that starts
      // declaring the same publisher date differently has changed what the
      // row says, and the hash has to move with the column.
      window.versionValidFrom,
      window.versionValidTo,
      input.fulltext ?? null,
      input.sections ?? null,
      input.ast ?? null,
      input.sourceUrl ?? null,
      input.documentUrl ?? null,
      input.metadata ?? {},
      input.rawHash,
      input.sourceRawContentType ?? null,
    ]),
  );
  return hasher.digest("hex");
};

/**
 * Report a version whose window does not meet its neighbours' edge to edge.
 *
 * Every connector's rows pass through here, so this is where the class of
 * defect that leaves a day uncovered (a publisher's inclusive end date stored
 * as the exclusive bound) or doubly covered (overlapping windows) is caught,
 * on the first crawl that writes two adjacent versions, rather than at a
 * point-in-time read months later. Telemetry, not a refusal: the row is
 * still the best text the corpus has for its window, and the fix is in the
 * connector. A wider gap is a version not yet ingested and is not reported;
 * the coverage census owns it.
 */
type ReportWindowJunctionsArgs = {
  input: Pick<LegislationDocumentInput, "sourceId" | "eli" | "language">;
  window: StoredWindow;
  documentId: SafeId<"legislationDocument">;
  scopedDb: ScopedDb;
};

const reportWindowJunctions = async ({
  input,
  window,
  documentId,
  scopedDb,
}: ReportWindowJunctionsArgs): Promise<void> => {
  const validFrom = window.versionValidFrom;
  if (validFrom === null) {
    return;
  }
  const work = and(
    eq(legislationDocuments.sourceId, input.sourceId),
    eq(legislationDocuments.eli, input.eli),
    eq(legislationDocuments.language, input.language),
  );
  const neighbour = async (
    where: SQL,
    order: SQL,
  ): Promise<{ validFrom: string | null; validTo: string | null }[]> =>
    await scopedDb((tx) =>
      tx
        .select({
          validFrom: legislationDocuments.versionValidFrom,
          validTo: legislationDocuments.versionValidTo,
        })
        .from(legislationDocuments)
        .where(and(work, where))
        .orderBy(order)
        .limit(1),
    );
  const [[earlier], [later]] = await Promise.all([
    neighbour(
      lt(legislationDocuments.versionValidFrom, validFrom),
      desc(legislationDocuments.versionValidFrom),
    ),
    neighbour(
      gt(legislationDocuments.versionValidFrom, validFrom),
      asc(legislationDocuments.versionValidFrom),
    ),
  ]);

  const run = [
    ...(earlier?.validFrom
      ? [{ validFrom: earlier.validFrom, validTo: earlier.validTo }]
      : []),
    { validFrom, validTo: window.versionValidTo },
    ...(later?.validFrom
      ? [{ validFrom: later.validFrom, validTo: later.validTo }]
      : []),
  ];
  for (const defect of defectiveJunctions(run)) {
    logger.error("legislation.ingestion.version_window_discontiguous", {
      documentId,
      sourceId: input.sourceId,
      eli: input.eli,
      language: input.language,
      earlierValidFrom: defect.earlier.validFrom,
      earlierValidTo: defect.earlier.validTo ?? "open",
      laterValidFrom: defect.later.validFrom,
      junction: defect.junction.type,
      overlapDays:
        defect.junction.type === "overlap" ? defect.junction.days : 0,
    });
  }
};

/** The raw-payload pointers a row carries, and what a run may write to them. */
type StoredSourceRaw = {
  sourceRawS3Key: string | null;
  sourceRawContentType: string | null;
};

const DEFAULT_SOURCE_RAW_CONTENT_TYPE = "text/plain";

type StoreSourceRawOptions = {
  input: LegislationDocumentInput;
  existing: StoredSourceRaw | undefined;
  writeSourceRaw: WriteRawSourcePayload;
};

/**
 * Store this observation's payload and return the pointers the row
 * should carry, or null when the write failed.
 *
 * An observation that carries no payload keeps whatever the row already
 * records: a later listing-only refresh must not erase a payload an earlier
 * fetch proved.
 */
const storeSourceRaw = async ({
  input,
  existing,
  writeSourceRaw,
}: StoreSourceRawOptions): Promise<StoredSourceRaw | null> => {
  const stored = {
    sourceRawS3Key: existing?.sourceRawS3Key ?? null,
    sourceRawContentType: existing?.sourceRawContentType ?? null,
  };
  const data = input.sourceRaw;
  if (data === undefined) {
    return stored;
  }
  const contentType =
    input.sourceRawContentType ?? DEFAULT_SOURCE_RAW_CONTENT_TYPE;
  const written = await Result.tryPromise({
    try: async () =>
      await writeSourceRaw({
        owner: {
          family: RAW_SOURCE_FAMILY.LEGISLATION,
          sourceId: input.sourceId,
        },
        data,
        contentType,
        storedKey: stored.sourceRawS3Key,
        storedContentType: stored.sourceRawContentType,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(written)) {
    logger.error("legislation.ingestion.source_raw_write_failed", {
      sourceId: input.sourceId,
      eli: input.eli,
    });
    captureError(written.error, {
      sourceId: input.sourceId,
      step: "processLegislationDocument.sourceRawWrite",
    });
    return null;
  }
  return { sourceRawS3Key: written.value, sourceRawContentType: contentType };
};

export type LegislationCorpusDependencies = {
  mode: CorpusStorageMode;
  write: typeof writeCorpusDocument;
};

const LEGISLATION_CORPUS_DEPENDENCIES: LegislationCorpusDependencies = {
  mode: corpusStorageMode,
  write: writeCorpusDocument,
};

type ProcessLegislationDocumentOptions = {
  corpus?: LegislationCorpusDependencies | undefined;
  /** Test seam; production writes through the object-storage client. */
  writeSourceRaw?: WriteRawSourcePayload | undefined;
};

/**
 * Store + upsert one legislation document. Deduplicates by a source hash
 * over the corpus payload plus all persisted metadata: an unchanged
 * re-ingest is skipped. The publisher's payload is stored first,
 * because a row written without it would dedup-skip forever. When corpus
 * storage is on, the canonical payload is written to object storage (outside
 * the tx). Its row pointers and desired corpus projection settle together;
 * the PostgreSQL full-text projection remains asynchronous.
 */
export const processLegislationDocument = async (
  raw: LegislationDocumentInput,
  scopedDb: ScopedDb,
  {
    corpus = LEGISLATION_CORPUS_DEPENDENCIES,
    writeSourceRaw = writeRawSourcePayload,
  }: ProcessLegislationDocumentOptions = {},
): Promise<ProcessLegislationResult> => {
  const input = sanitizeInput(raw);
  const text = input.fulltext ?? null;
  const sections = input.sections ?? null;
  const ast = input.ast ?? null;
  const window = storedWindow(input.version);
  const sourceHash = legislationSourceHash(input, window);
  const expectedContentHash = corpusContentHash({ text, sections, ast });

  const versionMatch = sql`${legislationDocuments.versionValidFrom} IS NOT DISTINCT FROM ${window.versionValidFrom}`;

  const [existing] = await scopedDb((tx) =>
    tx
      .select({
        id: legislationDocuments.id,
        sourceHash: legislationDocuments.sourceHash,
        // The write the row records for its corpus payload, so the corpus
        // write below can refuse re-PUTting objects it already proved.
        contentHash: legislationDocuments.contentHash,
        textS3Key: legislationDocuments.textS3Key,
        normalizedS3Key: legislationDocuments.normalizedS3Key,
        astS3Key: legislationDocuments.astS3Key,
        sourceRawS3Key: legislationDocuments.sourceRawS3Key,
        sourceRawContentType: legislationDocuments.sourceRawContentType,
      })
      .from(legislationDocuments)
      .where(
        and(
          eq(legislationDocuments.sourceId, input.sourceId),
          eq(legislationDocuments.eli, input.eli),
          eq(legislationDocuments.language, input.language),
          versionMatch,
        ),
      )
      .limit(1),
  );

  const existingCorpusPlan =
    existing === undefined
      ? null
      : planCorpusDocumentWrite({
          documentId: existing.id,
          jurisdiction: input.country,
          text,
          sections,
          ast,
          stored: storedCorpusWrite(existing),
        });
  const corpusAlreadySettled =
    corpus.mode === "off"
      ? existing?.contentHash === null &&
        existing.textS3Key === null &&
        existing.normalizedS3Key === null &&
        existing.astS3Key === null
      : existingCorpusPlan?.type === "skipped-unchanged" ||
        (existingCorpusPlan?.type === "skipped-empty" &&
          existing?.contentHash === expectedContentHash &&
          existing.textS3Key === null &&
          existing.normalizedS3Key === null &&
          existing.astS3Key === null);
  if (existing?.sourceHash === sourceHash && corpusAlreadySettled) {
    await settleLegislationCorpusProjection({
      documentId: existing.id,
      expectedSourceHash: sourceHash,
      outcome: null,
      scopedDb,
    });
    return {
      type: "stored",
      id: existing.id,
      inserted: false,
      skipped: true,
      corpusWriteFailed: false,
    };
  }

  const sourceRaw = await storeSourceRaw({ input, existing, writeSourceRaw });
  if (sourceRaw === null) {
    return { type: "source-raw-write-failed" };
  }

  const values = {
    sourceId: input.sourceId,
    eli: input.eli,
    slug: createStatuteSlug({ eli: input.eli, title: input.title }),
    title: input.title,
    country: input.country,
    language: input.language,
    documentType: input.documentType ?? null,
    status: input.status ?? "current",
    effectiveDate: input.effectiveDate ?? null,
    ...window,
    fulltext: text,
    sections,
    documentAst: ast,
    sourceUrl: input.sourceUrl ?? null,
    documentUrl: input.documentUrl ?? null,
    metadata: input.metadata ?? {},
    sourceHash,
    ...sourceRaw,
    ...(corpus.mode === "off"
      ? {
          textS3Key: null,
          normalizedS3Key: null,
          astS3Key: null,
          contentHash: null,
        }
      : {}),
  };

  const id = await scopedDb(async (tx) => {
    // audit: skip — background legislation ingestion; public data, not user actions
    if (existing) {
      await tx
        .update(legislationDocuments)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(legislationDocuments.id, existing.id));
      return existing.id;
    }
    const [row] = await tx
      .insert(legislationDocuments)
      .values(values)
      .returning({ id: legislationDocuments.id });
    if (!row) {
      panic("Failed to insert legislation document");
    }
    return row.id;
  });

  await reportWindowJunctions({ input, window, documentId: id, scopedDb });

  let corpusWriteFailed = false;
  // Legislation mirrors the payload whenever corpus storage is on and never
  // takes the `canonical` branch: that migration is deliberately case-law
  // first. Legislation's payload volume does not justify moving off the
  // Postgres columns, and its readers key off row state, which stays correct
  // either way. Treating `canonical` as `dual-write` here is the scope
  // decision, not an oversight.
  if (corpus.mode !== "off") {
    try {
      const outcome = await corpus.write({
        documentId: id,
        jurisdiction: input.country,
        text,
        sections,
        ast,
        stored: existing === undefined ? null : storedCorpusWrite(existing),
      });
      // An unchanged outcome means the row already records exactly these
      // pointers; a written or skipped-empty outcome records the keys, or
      // null pointers where the payload carried no document. The empty
      // payload's hash is still recorded: the corpus indexer's missing and
      // stale scans require a non-null content hash, so a row whose indexed
      // document refreshed to empty must stay visible to them — with a null
      // hash the previously indexed text would remain searchable forever.
      await settleLegislationCorpusProjection({
        documentId: id,
        expectedSourceHash: sourceHash,
        outcome,
        scopedDb,
      });
    } catch (error) {
      corpusWriteFailed = true;
      captureError(error, {
        documentId: id,
        sourceId: input.sourceId,
        step: "processLegislationDocument.corpusWrite",
      });
      await preserveLegislationCorpusWriteRetry({
        documentId: id,
        previousSourceHash: existing?.sourceHash ?? null,
        expectedSourceHash: sourceHash,
        scopedDb,
      });
    }
  } else {
    await settleLegislationCorpusProjection({
      documentId: id,
      expectedSourceHash: sourceHash,
      outcome: null,
      scopedDb,
    });
  }

  return {
    type: "stored",
    id,
    inserted: !existing,
    skipped: false,
    corpusWriteFailed,
  };
};

export type LegislationIngestionSource = {
  id: SafeId<"legislationSource">;
  syncCursor: string | null;
  config?: Record<string, unknown> | undefined;
};

export type RunLegislationIngestionOptions = {
  adapter: LegislationSourceAdapter;
  source: LegislationIngestionSource;
  scopedDb: ScopedDb;
  signal: AbortSignal;
  /** Cap for this cycle; defaults to the adapter's own, then MAX_SYNC_PAGES. */
  maxPages?: number | undefined;
  /** Test seam; production writes through the object-storage client. */
  writeSourceRaw?: WriteRawSourcePayload;
};

export type RunLegislationIngestionResult = {
  inserted: number;
  skipped: number;
  /**
   * URL fields nulled at the outbound boundary, across every document of
   * every page. Fields, not documents: the document is still stored, since a
   * statute must not become unreachable because one of its links was
   * off-policy.
   */
  urlsRefused: number;
  /**
   * What the source said each fully persisted slice holds. Returned rather
   * than persisted: legislation has no coverage ledger yet (it arrives with
   * the census), and dropping the adapter's own count on the floor is how a
   * short crawl becomes indistinguishable from a quiet slice.
   */
  coverage: SliceCoverage[];
  nextCursor: string | null;
};

/**
 * Drive a legislation adapter: fetch pages, check every URL against the
 * adapter's declared origins, persist each document, and advance the source
 * cursor. Bounded by pages per cycle, by the adapter's cycle timeout, and by
 * its per-page timeout.
 */
export const runLegislationIngestion = async ({
  adapter,
  source,
  scopedDb,
  signal,
  maxPages,
  writeSourceRaw,
}: RunLegislationIngestionOptions): Promise<RunLegislationIngestionResult> => {
  let cursor = source.syncCursor;
  let inserted = 0;
  let skipped = 0;
  let urlsRefused = 0;
  const coverage: SliceCoverage[] = [];

  const pageLimit = maxPages ?? adapter.maxSyncPages ?? MAX_SYNC_PAGES;
  const deadline = startCycleDeadline({
    budgetMs: adapter.maxCycleMs ?? MAX_CYCLE_MS,
    abortEarlyOn: [signal],
  });
  const pageTimeoutMs = adapter.pageTimeoutMs ?? ADAPTER_TIMEOUT.PAGE;

  /**
   * The publisher pause and the request as one step, so the pause spaces this
   * page from the previous one and the page timeout starts at the request.
   */
  const fetchPagePaced = async (
    pageIndex: number,
    pageCursor: string | null,
  ) => {
    if (pageIndex > 0 && adapter.minRequestIntervalMs > 0) {
      await Bun.sleep(adapter.minRequestIntervalMs);
    }
    return await adapter.fetchPage(
      pageCursor,
      source.config ?? {},
      AbortSignal.any([deadline.signal, AbortSignal.timeout(pageTimeoutMs)]),
    );
  };

  for (let page = 0; page < pageLimit; page += 1) {
    // The pause and the page timeout are what the next page costs. Starting
    // one the remaining budget cannot cover only throws its work away: the
    // cycle deadline aborts the fetch mid-flight and the cursor stays where
    // the last completed page left it either way.
    const nextPageMs =
      pageTimeoutMs + (page > 0 ? adapter.minRequestIntervalMs : 0);
    if (!canStartCyclePage(deadline, nextPageMs)) {
      break;
    }
    const pageResult = await fetchPagePaced(page, cursor);
    if (Result.isError(pageResult)) {
      // Hold the cursor: the page this cursor names was never read, so
      // advancing past it would skip whatever it held, permanently.
      logger.error("legislation.ingestion.page_fetch_failed", {
        adapterKey: adapter.key,
        sourceId: source.id,
        cursor: cursor ?? "",
      });
      break;
    }

    const { documents, nextCursor, coverage: pageCoverage } = pageResult.value;
    let corpusWriteFailures = 0;
    let sourceRawWriteFailures = 0;
    for (const document of documents) {
      const checked = restrictLegislationDocumentUrls({
        // The runner holds the source row, so it stamps the identity rather
        // than making every adapter recover it from its config.
        document: { ...document, sourceId: source.id },
        hostPolicy: adapter.outboundHostPolicy,
      });
      for (const refusal of checked.refusals) {
        urlsRefused += 1;
        // Redacted by construction: the refused value stays inside the
        // boundary, which reports only the field, host and reason.
        logger.error("legislation.ingestion.document_url_refused", {
          adapterKey: adapter.key,
          sourceId: source.id,
          eli: document.eli,
          field: refusal.field,
          host: refusal.host,
          reason: refusal.reason,
        });
      }
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- per-document store-and-upsert pipeline; the page cursor is held on write failure
      const result = await processLegislationDocument(
        checked.document,
        scopedDb,
        { writeSourceRaw },
      );
      if (result.type === "source-raw-write-failed") {
        sourceRawWriteFailures += 1;
        continue;
      }
      if (result.skipped) {
        skipped += 1;
      } else {
        inserted += 1;
      }
      if (result.corpusWriteFailed) {
        corpusWriteFailures += 1;
      }
    }
    if (corpusWriteFailures > 0 || sourceRawWriteFailures > 0) {
      // Hold the cursor on a page with failed object-storage writes: cursor
      // sources do not re-emit consumed pages, so advancing would leave
      // the preserved source-hash retry unreachable until the source
      // changes again.
      break;
    }
    // Only now: `collected` counts durably held records, so a page whose
    // writes failed must not report coverage for what it did not store.
    if (pageCoverage !== undefined) {
      coverage.push(pageCoverage);
    }
    cursor = nextCursor;
    if (nextCursor === null || documents.length === 0) {
      break;
    }
  }

  const checkpoint = await advanceCorpusIngestionCheckpoint({
    expectedCursor: source.syncCursor,
    nextCursor: cursor,
    scopedDb,
    source: { id: source.id, type: CORPUS_SOURCE_TYPE.LEGISLATION },
  });
  if (checkpoint.status === INGESTION_CHECKPOINT_STATUS.MISSING) {
    return panic("Legislation ingestion source disappeared before checkpoint");
  }
  if (checkpoint.status === INGESTION_CHECKPOINT_STATUS.SUPERSEDED) {
    logger.warn("legislation.ingestion.checkpoint_superseded", {
      sourceId: source.id,
    });
  }
  cursor = checkpoint.cursor;

  return { inserted, skipped, urlsRefused, coverage, nextCursor: cursor };
};
