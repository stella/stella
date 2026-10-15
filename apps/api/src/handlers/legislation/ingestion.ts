import { panic, Result } from "better-result";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { isEligibleLegislationExpression } from "@stll/api-contract/legislation-expression";
import type { LegislationWindowDispositionBasis } from "@stll/api-contract/legislation-expression";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import { restrictLegislationDocumentUrls } from "@/api/handlers/legislation/ingestion/outbound-urls";
import {
  LegislationRevision,
  LEGISLATION_CORPUS_DEPENDENCIES,
} from "@/api/handlers/legislation/revision";
import type {
  LegislationCorpusDependencies,
  LegislationRevisionProjection,
} from "@/api/handlers/legislation/revision";
import {
  defectiveJunctions,
  windowDisposition,
} from "@/api/handlers/legislation/version-windows";
import type { StoredWindow } from "@/api/handlers/legislation/version-windows";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  planCorpusDocumentWrite,
  storedCorpusWrite,
} from "@/api/lib/legal-search/corpus-storage";
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
import { typedLegislationClassification } from "@/api/lib/legal-search/legislation-expression-classification";
import type { LegislationExpressionClassification } from "@/api/lib/legal-search/legislation-expression-classification";
import type {
  LegislationDocumentInput,
  LegislationSourceAdapter,
} from "@/api/lib/legal-search/legislation-ingestion-types";
import {
  eligibleExpression,
  legislationVersionRef,
} from "@/api/lib/legal-search/legislation-validity-window";
import { syncLegislationWorkNamesTx } from "@/api/lib/legal-search/legislation-work-names";
import {
  RAW_SOURCE_FAMILY,
  writeRawSourcePayload,
} from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";

export { legislationSourceHash } from "@/api/handlers/legislation/revision";
export type { LegislationCorpusDependencies } from "@/api/handlers/legislation/revision";

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

/**
 * The writer contract this code writes under. A database fence refuses a
 * source-hash write from a transaction that has not declared it, so a writer
 * built before publisher identities existed, whose lookup by version window
 * can land on the wrong one of two same-day versions, cannot overwrite a row.
 */
export const LEGISLATION_WRITER_CONTRACT = "expression-v1";

export const declareWriterContract = async (tx: Transaction): Promise<void> => {
  await tx.execute(
    sql`SELECT set_config('stella.legislation_writer_contract', ${LEGISLATION_WRITER_CONTRACT}, true)`,
  );
};

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
    await declareWriterContract(tx);
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
  projection: LegislationRevisionProjection;
  scopedDb: ScopedDb;
};

/** Settle corpus pointers and the matching desired projection as one CAS. */
const settleLegislationCorpusProjection = async ({
  documentId,
  projection,
  scopedDb,
}: SettleLegislationCorpusProjectionInput): Promise<boolean> =>
  await scopedDb(async (tx) => {
    const { sourceHash: expectedSourceHash, outcome } = projection;
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
  classification: LegislationExpressionClassification;
  documentId: SafeId<"legislationDocument">;
  scopedDb: ScopedDb;
};

const reportWindowJunctions = async ({
  input,
  window,
  classification,
  documentId,
  scopedDb,
}: ReportWindowJunctionsArgs): Promise<void> => {
  const validFrom = window.versionValidFrom;
  // A version that cannot apply meets no neighbour: its dates are the
  // publisher's as stated, not a window any read would cross.
  if (validFrom === null || !isEligibleLegislationExpression(classification)) {
    return;
  }
  // Only versions that can apply are neighbours: a version that never took
  // effect or carries an inconsistent publisher window is not a junction the
  // point-in-time reads would ever cross.
  const work = and(
    eq(legislationDocuments.sourceId, input.sourceId),
    eq(legislationDocuments.eli, input.eli),
    eq(legislationDocuments.language, input.language),
    eligibleExpression(legislationVersionRef(legislationDocuments)),
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

/**
 * What the input says the version is: the kind its connector states, or the
 * one its window implies, and the disposition its window declares.
 *
 * A typed version (anything but an effective consolidation or unversioned
 * work) must carry the publisher's id. Without one it is found by its start
 * date, which two versions opening the same day share, so its classification
 * could land on the other one; that is a connector defect, named here.
 */
const statedClassification = (
  input: LegislationDocumentInput,
): LegislationExpressionClassification => {
  const unversioned = input.version.type === "unversioned";
  const expressionKind =
    input.expression?.kind ?? (unversioned ? "unversioned" : "consolidation");
  if ((expressionKind === "unversioned") !== unversioned) {
    return panic("legislation expression kind contradicts its window", {
      eli: input.eli,
      kind: expressionKind,
      window: input.version.type,
    });
  }
  const classification = {
    expressionKind,
    ...windowDisposition(input.version),
  };
  if (
    input.expression === undefined &&
    typedLegislationClassification(classification) !== null
  ) {
    return panic("a typed legislation version needs the publisher's id", {
      eli: input.eli,
      ...classification,
    });
  }
  return classification;
};

/**
 * The withdrawals a live listing of the version lifts: those that say only
 * that the publisher stopped listing it (or kept it out of the corpus), which
 * a listing now answers. A withdrawal for any other reason is the census's to
 * lift, whatever a writer sees.
 */
const LIFTED_BY_A_LIVE_LISTING: readonly LegislationWindowDispositionBasis[] = [
  "publisher-unlisted",
  "listed-not-stored",
];

/**
 * What the row will say the version is: what the input states, unless the
 * stored row is a withdrawal this observation cannot lift. Then the row keeps
 * exactly what it holds (kind, disposition and basis), and only its payload is
 * refreshed. Only an observation declared `live` lifts one: a snapshot, a
 * replay of a stored payload, or a writer that states no origin proves what
 * the publisher listed at some point, not now.
 */
const storedClassification = (
  input: LegislationDocumentInput,
  stated: LegislationExpressionClassification,
  existing: StoredVersion | undefined,
): LegislationExpressionClassification => {
  if (existing?.windowDisposition !== "withdrawn") {
    return stated;
  }
  const lifted =
    input.origin === "live" &&
    existing.windowDispositionBasis !== null &&
    LIFTED_BY_A_LIVE_LISTING.includes(existing.windowDispositionBasis);
  return lifted
    ? stated
    : {
        expressionKind: existing.expressionKind,
        windowDisposition: existing.windowDisposition,
        windowDispositionBasis: existing.windowDispositionBasis,
      };
};

const hasStoredClassification = (
  row: StoredVersion,
  classification: LegislationExpressionClassification,
): boolean =>
  row.expressionKind === classification.expressionKind &&
  row.windowDisposition === classification.windowDisposition &&
  row.windowDispositionBasis === classification.windowDispositionBasis;

/**
 * Serialise every write that could give one publisher identity a row: the
 * claim of a legacy row and the insert of a new one. Until the identity is
 * unique in the database (a later release builds that index online), this
 * transaction-scoped lock is what keeps two writers from storing one version
 * twice.
 */
const lockExpressionIdentity = async (
  tx: Transaction,
  input: LegislationDocumentInput,
  publisherId: string,
): Promise<void> => {
  const key = JSON.stringify([
    "legislation-expression",
    input.sourceId,
    input.eli,
    input.language,
    publisherId,
  ]);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
};

const STORED_VERSION_COLUMNS = {
  id: legislationDocuments.id,
  sourceHash: legislationDocuments.sourceHash,
  // The write the row records for its corpus payload, so the corpus
  // write can refuse re-PUTting objects it already proved.
  contentHash: legislationDocuments.contentHash,
  textS3Key: legislationDocuments.textS3Key,
  normalizedS3Key: legislationDocuments.normalizedS3Key,
  astS3Key: legislationDocuments.astS3Key,
  sourceRawS3Key: legislationDocuments.sourceRawS3Key,
  sourceRawContentType: legislationDocuments.sourceRawContentType,
  expressionKind: legislationDocuments.expressionKind,
  windowDisposition: legislationDocuments.windowDisposition,
  windowDispositionBasis: legislationDocuments.windowDispositionBasis,
};

type StoredVersion = {
  id: SafeId<"legislationDocument">;
  sourceHash: string | null;
  contentHash: string | null;
  textS3Key: string | null;
  normalizedS3Key: string | null;
  astS3Key: string | null;
  sourceRawS3Key: string | null;
  sourceRawContentType: string | null;
} & LegislationExpressionClassification;

type StoredVersionLookup = {
  input: LegislationDocumentInput;
  scopedDb: ScopedDb;
};

const workOf = (input: LegislationDocumentInput): SQL | undefined =>
  and(
    eq(legislationDocuments.sourceId, input.sourceId),
    eq(legislationDocuments.eli, input.eli),
    eq(legislationDocuments.language, input.language),
  );

const storedVersionQuery = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(STORED_VERSION_COLUMNS)
    .from(legislationDocuments)
    .where(where)
    // Deterministic should a duplicate ever exist.
    .orderBy(asc(legislationDocuments.id))
    .limit(1);

/** The row, locked for the write that decides from it. */
const lockStoredVersionTx = async (
  tx: Transaction,
  where: SQL | undefined,
): Promise<StoredVersion | undefined> =>
  (await storedVersionQuery(tx, where).for("update")).at(0);

/**
 * Update the stored version, or insert it with its publisher id, and write the
 * names its title states in the same transaction, so a search never sees the
 * version without them.
 */
const writeDecidedVersionTx = async (
  tx: Transaction,
  row: StoredVersion | undefined,
  values: typeof legislationDocuments.$inferInsert,
  publisherId: string | undefined,
) => {
  let id = row?.id;
  // audit: skip — background legislation ingestion; public data, not user actions
  if (id === undefined) {
    const [insertedRow] = await tx
      .insert(legislationDocuments)
      .values({ ...values, publisherExpressionId: publisherId ?? null })
      .returning({ id: legislationDocuments.id });
    if (!insertedRow) {
      panic("Failed to insert legislation document");
    }
    id = insertedRow.id;
  } else {
    await tx
      .update(legislationDocuments)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(legislationDocuments.id, id));
  }
  await syncLegislationWorkNamesTx(tx, [
    { id, country: values.country, title: values.title },
  ]);
  return id;
};

type CommitLegislationVersionOptions = {
  revision: LegislationRevision;
  existing: StoredVersion | undefined;
  stated: LegislationExpressionClassification;
  sourceRaw: StoredSourceRaw;
  corpusMode: LegislationCorpusDependencies["mode"];
  scopedDb: ScopedDb;
};

/**
 * Update the version's row, or insert it. Under the identity lock a writer
 * that found nothing looks once more before inserting: a concurrent writer
 * may have stored the version since, and then its row is this version's row.
 *
 * The row is read again under its lock and the classification decided from
 * that read, not the one before the payload write: a withdrawal committed in
 * between is what the row now says, and a write decided from the older read
 * would lift it.
 */
const commitLegislationVersion = async ({
  revision,
  existing,
  stated,
  sourceRaw,
  corpusMode,
  scopedDb,
}: CommitLegislationVersionOptions) =>
  await scopedDb(async (tx) => {
    const input = revision.input;
    await declareWriterContract(tx);
    // Settle and the write-error retry take the projection source before the
    // row; this write takes them in the same order so they cannot deadlock.
    const projectionLock =
      corpusMode === "off" || existing === undefined
        ? null
        : await lockActiveCorpusProjectionSourceTx(tx, {
            family: "legislation",
            entityId: existing.id,
          });
    const publisherId = input.expression?.publisherId;
    let row =
      existing === undefined
        ? undefined
        : await lockStoredVersionTx(
            tx,
            eq(legislationDocuments.id, existing.id),
          );
    if (row === undefined && publisherId !== undefined) {
      await lockExpressionIdentity(tx, input, publisherId);
      row = await lockStoredVersionTx(tx, byPublisherId(input, publisherId));
    }
    const decided = storedClassification(input, stated, row);
    // The new body reaches object storage only after this commit. Until it
    // settles, the stored pointers would serve the previous body under this
    // write's metadata, so a changed body clears them: reads use the columns
    // written here and the search projection stops serving the old passages.
    const bodyChanged =
      corpusMode !== "off" &&
      row !== undefined &&
      row.contentHash !== revision.contentHash;
    const decidedValues = {
      ...revision.values(sourceRaw),
      ...decided,
      ...(bodyChanged || corpusMode === "off"
        ? {
            textS3Key: null,
            normalizedS3Key: null,
            astS3Key: null,
            contentHash: null,
          }
        : {}),
      sourceHash: revision.sourceHash(decided),
    };
    const id = await writeDecidedVersionTx(tx, row, decidedValues, publisherId);
    if (bodyChanged && projectionLock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock: projectionLock,
        subject: { family: "legislation", entityId: id },
      });
    }
    return {
      id,
      row,
      classification: decided,
      sourceHash: decidedValues.sourceHash,
    };
  });

const selectStoredVersion = async (
  scopedDb: ScopedDb,
  where: SQL | undefined,
): Promise<StoredVersion | undefined> =>
  await scopedDb(async (tx) => (await storedVersionQuery(tx, where)).at(0));

const byPublisherId = (
  input: LegislationDocumentInput,
  publisherId: string,
): SQL | undefined =>
  and(
    workOf(input),
    eq(legislationDocuments.publisherExpressionId, publisherId),
  );

const findByPublisherId = async ({
  input,
  publisherId,
  scopedDb,
}: StoredVersionLookup & {
  publisherId: string;
}): Promise<StoredVersion | undefined> =>
  await selectStoredVersion(scopedDb, byPublisherId(input, publisherId));

type LegacyRowColumns = {
  metadata: SQLWrapper;
  versionValidFrom: SQLWrapper;
};

/**
 * Which row written before publisher identities this version is, and which to
 * prefer when more than one could be.
 *
 * The stored version IRI is the proof, whatever the row's window says: a
 * publisher that has since moved the version's start still names the same
 * version, and adopting by the old start would leave that row behind and
 * store the version twice. Only a row that stores no IRI falls back to the
 * version window. A work kept as one text is its single windowless row.
 * Null when the id names nothing a legacy row can be matched on, so nothing is
 * adopted by guess.
 */
const legacyIdentityMatch = (
  input: LegislationDocumentInput,
  publisherId: string,
  window: StoredWindow,
  legacy: LegacyRowColumns,
): { match: SQL; preference: SQL } | null => {
  const separator = publisherId.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const native = publisherId.slice(separator + 1);
  if (input.version.type === "unversioned") {
    return native === `work:${input.eli}`
      ? {
          match: sql`${legacy.versionValidFrom} IS NULL`,
          preference: sql`${legacy.versionValidFrom} IS NULL DESC`,
        }
      : null;
  }
  const storedIri = sql`(${legacy.metadata}->>'versionIri')`;
  const provenByIri = sql`${storedIri} = ${native}`;
  return {
    match: sql`(${provenByIri} OR (coalesce(${storedIri}, '') = '' AND ${legacy.versionValidFrom} IS NOT DISTINCT FROM ${window.versionValidFrom}))`,
    // An IRI match wins over a window-only one.
    preference: sql`(${provenByIri}) IS TRUE DESC`,
  };
};

/**
 * Give a row written before publisher identities its id, in place, so it keeps
 * its UUID and everything that references it.
 *
 * A compare-and-set, not a read then a write: the row is chosen and claimed in
 * one statement that only succeeds while its id is still null, so of two
 * writers (or a writer and the backfill) claiming the same row exactly one
 * wins and the other finds the row by its id afterwards. A row whose IRI names
 * a different version is never adopted.
 *
 * Bounded by the work: the candidates are the rows of one
 * `(source, eli, language)`, reached through the ELI index, and a work holds
 * one row per version.
 */
const claimLegacyVersion = async ({
  input,
  publisherId,
  window,
  scopedDb,
}: StoredVersionLookup & {
  publisherId: string;
  window: StoredWindow;
}): Promise<void> => {
  const legacy = alias(legislationDocuments, "legacy");
  const identity = legacyIdentityMatch(input, publisherId, window, legacy);
  if (identity === null) {
    return;
  }
  await scopedDb(async (tx) => {
    await declareWriterContract(tx);
    await lockExpressionIdentity(tx, input, publisherId);
    const unclaimed = tx
      .select({ id: legacy.id })
      .from(legacy)
      .where(
        and(
          eq(legacy.sourceId, input.sourceId),
          eq(legacy.eli, input.eli),
          eq(legacy.language, input.language),
          isNull(legacy.publisherExpressionId),
          identity.match,
        ),
      )
      .orderBy(identity.preference, asc(legacy.id))
      .limit(1);
    // audit: skip — background legislation ingestion; attaches the publisher's identity to an existing public row
    await tx
      .update(legislationDocuments)
      // An identity attachment, not an edit: `updated_at` keeps its value.
      .set({
        publisherExpressionId: publisherId,
        updatedAt: sql`${legislationDocuments.updatedAt}`,
      })
      .where(
        and(
          sql`${legislationDocuments.id} = (${unclaimed})`,
          isNull(legislationDocuments.publisherExpressionId),
        ),
      );
  });
};

/**
 * The row this version is stored in, if any.
 *
 * By the publisher's id when the connector supplies one: first the row that
 * already carries it, then a row written before ids existed that this version
 * can be proven to be (claimed in place), then once more by id, which finds
 * the row a concurrent claim or the backfill attached. The version-window
 * lookup is only for input that carries no id.
 */
const findStoredVersion = async ({
  input,
  window,
  scopedDb,
}: StoredVersionLookup & {
  window: StoredWindow;
}): Promise<StoredVersion | undefined> => {
  if (input.expression === undefined) {
    return await selectStoredVersion(
      scopedDb,
      and(
        workOf(input),
        sql`${legislationDocuments.versionValidFrom} IS NOT DISTINCT FROM ${window.versionValidFrom}`,
      ),
    );
  }
  const { publisherId } = input.expression;
  const stored = await findByPublisherId({ input, publisherId, scopedDb });
  if (stored !== undefined) {
    return stored;
  }
  await claimLegacyVersion({ input, publisherId, window, scopedDb });
  return await findByPublisherId({ input, publisherId, scopedDb });
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
  const revision = new LegislationRevision(raw);
  const input = revision.input;
  const window = revision.window;
  const stated = statedClassification(input);
  const expectedContentHash = revision.contentHash;

  let existing = await findStoredVersion({ input, window, scopedDb });
  let classification = storedClassification(input, stated, existing);
  let sourceHash = revision.sourceHash(classification);
  const existingCorpusPlan =
    existing === undefined
      ? null
      : planCorpusDocumentWrite({
          documentId: existing.id,
          jurisdiction: input.country,
          ...revision.payload,
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
  if (
    existing?.sourceHash === sourceHash &&
    corpusAlreadySettled &&
    hasStoredClassification(existing, classification)
  ) {
    await settleLegislationCorpusProjection({
      documentId: existing.id,
      projection: revision.withoutCorpusWrite(classification),
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

  const written = await commitLegislationVersion({
    revision,
    existing,
    stated,
    sourceRaw,
    corpusMode: corpus.mode,
    scopedDb,
  });
  const { id } = written;
  const inserted = written.row === undefined;
  existing = written.row;
  classification = written.classification;
  sourceHash = written.sourceHash;

  await reportWindowJunctions({
    input,
    window,
    classification,
    documentId: id,
    scopedDb,
  });

  let corpusWriteFailed = false;
  // Legislation mirrors the payload whenever corpus storage is on and never
  // takes the `canonical` branch: that migration is deliberately case-law
  // first. Legislation's payload volume does not justify moving off the
  // Postgres columns, and its readers key off row state, which stays correct
  // either way. Treating `canonical` as `dual-write` here is the scope
  // decision, not an oversight.
  if (corpus.mode !== "off") {
    try {
      const projection = await revision.writeCorpus({
        documentId: id,
        stored: existing === undefined ? null : storedCorpusWrite(existing),
        classification,
        write: corpus.write,
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
        projection,
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
      projection: revision.withoutCorpusWrite(classification),
      scopedDb,
    });
  }

  return {
    type: "stored",
    id,
    inserted,
    skipped: false,
    corpusWriteFailed,
  };
};

type LegislationIngestionSource = {
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
        // than making every adapter recover it from its config. A page an
        // adapter fetched is live unless the adapter says otherwise.
        document: {
          ...document,
          sourceId: source.id,
          origin: document.origin ?? "live",
        },
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
      // db-await-in-loop: per-document store-and-upsert pipeline; the page cursor is held on write failure
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
