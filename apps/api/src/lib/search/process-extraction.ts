/** Durable native extraction request and worker-side execution. */

import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  SCOPED_NATIVE_EXTRACTION_ENQUEUE,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { requestAutomaticDocumentOcr } from "@/api/lib/document-processing-automatic-request";
import { DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { restoreManualOcrRunAfterProjectionLoss } from "@/api/lib/document-processing-manual-ocr-restore";
import { shouldGeneratePdfDerivative } from "@/api/lib/files/pdf-derivative-policy";
import { createFileKey } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import { getS3ObjectWithSignal } from "@/api/lib/s3";
import {
  extractFileTextResult,
  resolveExtractionMimeType,
} from "@/api/lib/search/extract-content";
import { canExtractMimeType } from "@/api/lib/search/extractable-mime-types";
import { getSearchProvider } from "@/api/lib/search/provider";
import {
  findExtractionFileField,
  findExtractionFileFieldRow,
} from "@/api/lib/search/types";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type ExtractionSource = {
  fileId: string;
  storageMimeType: string;
  extractionMimeType: string;
};

/**
 * Choose which S3 object to extract text from.
 *
 * The original file wins whenever a parser handles its format
 * directly. Going through the Gotenberg PDF derivative instead
 * would read text off a paginated rendering: spreadsheet columns
 * are scaled to fit a page and anything past the last fitted
 * column never reaches the PDF at all.
 *
 * Formats with no direct parser (images, HTML, iWork) still fall
 * back to the PDF copy, which is the only text layer they have.
 */
export const pickExtractionSource = (
  fileField: Extract<FieldContent, { type: "file" }>,
): ExtractionSource => {
  const extractionMimeType = resolveExtractionMimeType({
    fileName: fileField.fileName,
    mimeType: fileField.mimeType,
  });

  if (!canExtractMimeType(extractionMimeType) && fileField.pdfFileId) {
    return {
      fileId: fileField.pdfFileId,
      storageMimeType: PDF_MIME_TYPE,
      extractionMimeType: PDF_MIME_TYPE,
    };
  }

  return {
    fileId: fileField.id,
    storageMimeType: fileField.mimeType,
    extractionMimeType,
  };
};

export const requiresDurableNativeExtraction = (
  fileField: Extract<FieldContent, { type: "file" }>,
): boolean => {
  if (fileField.encrypted) {
    return false;
  }
  if (
    fileField.pdfFileId === null &&
    shouldGeneratePdfDerivative({
      encrypted: fileField.encrypted,
      mimeType: fileField.mimeType,
    })
  ) {
    return false;
  }
  return canExtractMimeType(pickExtractionSource(fileField).extractionMimeType);
};

/**
 * Which mechanism writes an entity's search projection once its current
 * version is committed.
 *
 * `durable-extraction` means a document-processing run owns it: the run
 * persists the extracted text and indexes the entity when it completes, so a
 * search mark written beside it would index the same entity a second time
 * with no text. `search-mark` means nothing else will write the projection,
 * so the mutation must mark the entity dirty inside its own transaction.
 *
 * `processExtraction` reads this to pick its own branch, so a caller that
 * splits its entities by owner cannot drift from what extraction actually
 * does with them.
 */
export const SEARCH_INDEX_OWNER = {
  durableExtraction: "durable-extraction",
  searchMark: "search-mark",
} as const;

export type SearchIndexOwner =
  (typeof SEARCH_INDEX_OWNER)[keyof typeof SEARCH_INDEX_OWNER];

/**
 * `fields` must arrive in the same stable order `findExtractionFileField`
 * requires: ascending field id, which is ascending creation order.
 */
export const searchIndexOwnerForFields = (
  fields: readonly {
    content: FieldContent;
    propertyId?: SafeId<"property"> | undefined;
  }[],
  filePropertyId?: SafeId<"property">,
): SearchIndexOwner => {
  const fileField = findExtractionFileField(fields, filePropertyId);
  return fileField && requiresDurableNativeExtraction(fileField)
    ? SEARCH_INDEX_OWNER.durableExtraction
    : SEARCH_INDEX_OWNER.searchMark;
};

type NativeExtractionProjectionOptions = {
  charCount: number;
  ciphertext: Buffer;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  iv: Buffer;
  organizationId: SafeId<"organization">;
  sourceFileId: string;
  sourceSha256Hex: string;
  workspaceId: SafeId<"workspace">;
};

type PersistedNativeExtractionProjection = {
  entityId: SafeId<"entity">;
};

export type NativeExtractionProjectionOutcome =
  | "persisted"
  | "preserved"
  | "source_cancelled";

export const persistNativeExtractionProjection = async (
  {
    charCount,
    ciphertext,
    entityId,
    entityVersionId,
    fieldId,
    iv,
    organizationId,
    sourceFileId,
    sourceSha256Hex,
    workspaceId,
  }: NativeExtractionProjectionOptions,
  database: Pick<typeof rootDb, "transaction"> = rootDb,
): Promise<NativeExtractionProjectionOutcome> =>
  await database.transaction(async (tx) => {
    // Manual OCR request and projection transactions take this same lock first.
    // Keeping the conditional write in the next statement gives it a fresh
    // READ COMMITTED snapshot after any lock waiter ahead of us commits.
    const lockedSources =
      await tx.execute<PersistedNativeExtractionProjection>(sql`
        SELECT e.id AS "entityId"
        FROM entities e
        INNER JOIN fields f
          ON f.id = ${fieldId}
          AND f.workspace_id = ${workspaceId}
          AND f.entity_version_id = ${entityVersionId}
        WHERE e.id = ${entityId}
          AND e.workspace_id = ${workspaceId}
          AND e.current_version_id = ${entityVersionId}
          AND f.content->>'type' = 'file'
          AND f.content->>'id' = ${sourceFileId}
          AND f.content->>'sha256Hex' = ${sourceSha256Hex}
        FOR UPDATE OF e
      `);
    if (!lockedSources.at(0)) {
      return "source_cancelled";
    }

    const persisted = await tx.execute<PersistedNativeExtractionProjection>(sql`
        WITH manual_projection_ownership AS MATERIALIZED (
          SELECT 1
          FROM document_processing_runs manual_run
          WHERE manual_run.organization_id = ${organizationId}
            AND manual_run.workspace_id = ${workspaceId}
            AND manual_run.entity_id = ${entityId}
            AND manual_run.entity_version_id = ${entityVersionId}
            AND manual_run.kind = 'ocr'
            AND manual_run.request_source = 'manual'
            AND (
              manual_run.status IN ('queued', 'running')
              OR (
                (
                  manual_run.status = 'succeeded'
                  OR (
                    manual_run.status = 'failed'
                    AND manual_run.error_code = 'search_index_failed'
                  )
                )
                AND EXISTS (
                  SELECT 1
                  FROM extracted_content selected_projection
                  WHERE selected_projection.organization_id = ${organizationId}
                    AND selected_projection.workspace_id = ${workspaceId}
                    AND selected_projection.entity_id = ${entityId}
                    AND selected_projection.source_entity_version_id = manual_run.entity_version_id
                    AND selected_projection.source_field_id = manual_run.field_id
                    AND selected_projection.source_file_id = manual_run.source_file_id
                    AND selected_projection.source_sha256_hex = manual_run.source_sha256_hex
                )
              )
            )
          LIMIT 1
        )
        INSERT INTO extracted_content (
          entity_id, organization_id, workspace_id,
          source_entity_version_id, source_field_id,
          source_file_id, source_sha256_hex,
          ciphertext, iv, char_count, language, extracted_at
        )
        SELECT
          ${entityId}, ${organizationId}, ${workspaceId},
          ${entityVersionId}, ${fieldId},
          ${sourceFileId}, ${sourceSha256Hex},
          ${ciphertext}, ${iv}, ${charCount}, NULL, now()
        FROM entities e
        INNER JOIN fields f
          ON f.id = ${fieldId}
          AND f.workspace_id = ${workspaceId}
          AND f.entity_version_id = ${entityVersionId}
        WHERE e.id = ${entityId}
          AND e.workspace_id = ${workspaceId}
          AND e.current_version_id = ${entityVersionId}
          AND f.content->>'type' = 'file'
          AND f.content->>'id' = ${sourceFileId}
          AND f.content->>'sha256Hex' = ${sourceSha256Hex}
          AND NOT EXISTS (SELECT 1 FROM manual_projection_ownership)
        ON CONFLICT (entity_id) DO UPDATE SET
          organization_id = EXCLUDED.organization_id,
          workspace_id = EXCLUDED.workspace_id,
          source_entity_version_id = EXCLUDED.source_entity_version_id,
          source_field_id = EXCLUDED.source_field_id,
          source_file_id = EXCLUDED.source_file_id,
          source_sha256_hex = EXCLUDED.source_sha256_hex,
          ocr_run_id = NULL,
          ocr_processor_version = NULL,
          ocr_payload_ciphertext = NULL,
          ocr_payload_iv = NULL,
          ciphertext = EXCLUDED.ciphertext,
          iv = EXCLUDED.iv,
          char_count = EXCLUDED.char_count,
          language = EXCLUDED.language,
          extracted_at = EXCLUDED.extracted_at
        WHERE NOT EXISTS (SELECT 1 FROM manual_projection_ownership)
        RETURNING entity_id AS "entityId"
      `);
    return persisted.at(0) === undefined ? "preserved" : "persisted";
  });

type NativeExtractionRun = Pick<
  typeof documentProcessingRuns.$inferSelect,
  | "entityId"
  | "entityVersionId"
  | "fieldId"
  | "organizationId"
  | "sourceFileId"
  | "sourceSha256Hex"
  | "workspaceId"
>;

export const executeNativeExtraction = async ({
  fileField,
  lifecycleSignal,
  readSource = getS3ObjectWithSignal,
  run,
  dependencies = EXECUTE_NATIVE_EXTRACTION_DEPENDENCIES,
}: {
  fileField: Extract<FieldContent, { type: "file" }>;
  lifecycleSignal: AbortSignal;
  readSource?: (key: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  run: NativeExtractionRun;
  dependencies?: ExecuteNativeExtractionDependencies | undefined;
}): Promise<NativeExtractionProjectionOutcome> => {
  const {
    extractText,
    persistProjection,
    requestAutomaticOcr,
    restoreManualOcr,
  } = dependencies;
  const source = pickExtractionSource(fileField);
  const key = createFileKey({
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    fileId: source.fileId,
    mimeType: source.storageMimeType,
  });
  const buffer = await withTimeout(
    async (signal) => await readSource(key, signal),
    {
      label: "native extraction source read",
      signal: lifecycleSignal,
      timeoutMs: LIMITS.documentProcessingObjectReadTimeoutMs,
    },
  );
  lifecycleSignal.throwIfAborted();
  const extraction = await extractText(buffer, source.extractionMimeType, {
    signal: lifecycleSignal,
    timeoutMs: LIMITS.documentProcessingExtractionTimeoutMs,
  });
  if (Result.isError(extraction)) {
    throw extraction.error;
  }
  lifecycleSignal.throwIfAborted();

  const text = extraction.value;
  const persistedText = text ?? "";
  const encrypted = await encryptContent(run.organizationId, persistedText);
  lifecycleSignal.throwIfAborted();
  const persistenceOutcome = await persistProjection({
    charCount: persistedText.length,
    ciphertext: encrypted.ciphertext,
    entityId: run.entityId,
    entityVersionId: run.entityVersionId,
    fieldId: run.fieldId,
    iv: encrypted.iv,
    organizationId: run.organizationId,
    sourceFileId: run.sourceFileId,
    sourceSha256Hex: run.sourceSha256Hex,
    workspaceId: run.workspaceId,
  });
  if (persistenceOutcome === "source_cancelled") {
    return persistenceOutcome;
  }

  if (source.extractionMimeType === PDF_MIME_TYPE) {
    await restoreManualOcr({
      entityId: run.entityId,
      entityVersionId: run.entityVersionId,
      fieldId: run.fieldId,
      organizationId: run.organizationId,
      sourceFileId: run.sourceFileId,
      sourceSha256Hex: run.sourceSha256Hex,
      workspaceId: run.workspaceId,
    });
  }

  if (persistenceOutcome !== "persisted") {
    return persistenceOutcome;
  }

  if (text === null && source.extractionMimeType === PDF_MIME_TYPE) {
    await requestAutomaticOcr({
      entityId: run.entityId,
      entityVersionId: run.entityVersionId,
      fieldId: run.fieldId,
      organizationId: run.organizationId,
      requestSource: "upload",
      sourceFileId: run.sourceFileId,
      sourceSha256Hex: run.sourceSha256Hex,
      workspaceId: run.workspaceId,
    });
  }
  return persistenceOutcome;
};

export type ExecuteNativeExtractionDependencies = {
  extractText: typeof extractFileTextResult;
  persistProjection: typeof persistNativeExtractionProjection;
  requestAutomaticOcr: typeof requestAutomaticDocumentOcr;
  restoreManualOcr: typeof restoreManualOcrRunAfterProjectionLoss;
};

const EXECUTE_NATIVE_EXTRACTION_DEPENDENCIES: ExecuteNativeExtractionDependencies =
  {
    extractText: extractFileTextResult,
    persistProjection: persistNativeExtractionProjection,
    requestAutomaticOcr: requestAutomaticDocumentOcr,
    restoreManualOcr: restoreManualOcrRunAfterProjectionLoss,
  };

/**
 * The immutable source identity of a native-extraction run. Both request paths
 * converge on it, so a duplicate enqueue can never create a second run for the
 * same file.
 */
const NATIVE_EXTRACTION_SOURCE_TARGET = [
  documentProcessingRuns.organizationId,
  documentProcessingRuns.kind,
  documentProcessingRuns.entityVersionId,
  documentProcessingRuns.fieldId,
  documentProcessingRuns.sourceFileId,
  documentProcessingRuns.sourceSha256Hex,
  documentProcessingRuns.processorVersion,
];

/** Read handle only: the entity read runs on `rootDb` or on a scoped tx. */
type ExtractionEntityReader = Pick<typeof rootDb, "query">;

/**
 * Load the entity state both request paths decide on. Sharing one query keeps
 * the in-transaction request and the post-commit request resolving the same
 * source file for the same entity.
 */
const readExtractionEntity = async (
  db: ExtractionEntityReader,
  entityId: SafeId<"entity">,
) =>
  await db.query.entities.findFirst({
    where: { id: { eq: entityId } },
    columns: { id: true, workspaceId: true },
    with: {
      workspace: {
        columns: {
          id: true,
          organizationId: true,
        },
      },
      currentVersion: {
        columns: { id: true },
        with: {
          // Fields of one entity version: at most one row per property
          // (fields_property_id_entity_version_id_key), so this is
          // structurally bounded by properties-per-workspace; `limit` pins
          // that same bound explicitly for the lint rule below.
          // `id` is a Bun.randomUUIDv7() primary key (time-ordered), so
          // ordering by it gives a stable field-creation order. This MUST
          // match the ordering `readEntityByIdHandler` applies to the same
          // relation -- both feed `findExtractionFileField`'s "first file
          // field" selection, which must resolve to the SAME field
          // wherever it runs (see findExtractionFileField).
          fields: {
            columns: { content: true, id: true, propertyId: true },
            orderBy: { id: "asc" },
            limit: LIMITS.propertiesCount,
          },
        },
      },
    },
  });

type ExtractionEntity = NonNullable<
  Awaited<ReturnType<typeof readExtractionEntity>>
>;

export type NativeExtractionRunRequest = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  fileField: Extract<FieldContent, { type: "file" }>;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

type NativeExtractionRequestOptions = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fields: readonly {
    content: FieldContent;
    id: SafeId<"field">;
    propertyId?: SafeId<"property"> | undefined;
  }[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  filePropertyId?: SafeId<"property"> | undefined;
};

type NativeExtractionRequestResult = NativeExtractionRunRequest | null;

/**
 * Derive the exact immutable source identity from fields a transaction has
 * persisted in stable creation order. A null result means the search-repair
 * queue, not a document-processing run, owns the projection.
 */
export const nativeExtractionRunRequestForFields = ({
  entityId,
  entityVersionId,
  fields,
  organizationId,
  workspaceId,
  filePropertyId,
}: NativeExtractionRequestOptions): NativeExtractionRequestResult => {
  const fileFieldRow = findExtractionFileFieldRow(fields, filePropertyId);
  if (
    !fileFieldRow ||
    fileFieldRow.content.type !== "file" ||
    !requiresDurableNativeExtraction(fileFieldRow.content)
  ) {
    return null;
  }
  return {
    entityId,
    entityVersionId,
    fieldId: fileFieldRow.id,
    fileField: fileFieldRow.content,
    organizationId,
    workspaceId,
  };
};

/** `null` when a search mark, not a durable run, owns this projection. */
const resolveNativeExtractionSource = (
  entityId: SafeId<"entity">,
  entity: ExtractionEntity,
  filePropertyId?: SafeId<"property">,
): NativeExtractionRunRequest | null => {
  const workspace = entity.workspace ?? panic("Entity has no workspace");
  const version =
    entity.currentVersion ?? panic("Entity has no currentVersion");
  return nativeExtractionRunRequestForFields({
    entityId,
    entityVersionId: version.id,
    fields: version.fields,
    filePropertyId,
    organizationId: toSafeId<"organization">(workspace.organizationId),
    workspaceId: toSafeId<"workspace">(workspace.id),
  });
};

const nativeExtractionRunValues = (request: NativeExtractionRunRequest) =>
  ({
    id: createSafeId<"documentProcessingRun">(),
    ...SCOPED_NATIVE_EXTRACTION_ENQUEUE,
    entityId: request.entityId,
    entityVersionId: request.entityVersionId,
    fieldId: request.fieldId,
    organizationId: request.organizationId,
    processorVersion: DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
    sourceFileId: request.fileField.id,
    sourceSha256Hex: request.fileField.sha256Hex,
    workspaceId: request.workspaceId,
  }) satisfies typeof documentProcessingRuns.$inferInsert;

// 250 rows keep the insert well below PostgreSQL's bound-parameter ceiling
// while reducing a whole-matter copy from one request query per document to a
// small, bounded number of statements.
const NATIVE_EXTRACTION_RUN_INSERT_BATCH_SIZE = 250;

/** Insert immutable-source requests in bounded batches on one transaction. */
export const requestNativeExtractionRuns = async ({
  requests,
  tx,
}: {
  requests: readonly NativeExtractionRunRequest[];
  tx: Transaction;
}): Promise<SafeId<"documentProcessingRun">[]> => {
  const insertedRunIds: SafeId<"documentProcessingRun">[] = [];
  const insertFrom = async (start: number): Promise<void> => {
    if (start >= requests.length) {
      return;
    }
    const inserted = await tx
      .insert(documentProcessingRuns)
      .values(
        requests
          .slice(start, start + NATIVE_EXTRACTION_RUN_INSERT_BATCH_SIZE)
          .map(nativeExtractionRunValues),
      )
      .onConflictDoNothing({ target: NATIVE_EXTRACTION_SOURCE_TARGET })
      .returning({ id: documentProcessingRuns.id });
    insertedRunIds.push(...inserted.map(({ id }) => id));
    await insertFrom(start + NATIVE_EXTRACTION_RUN_INSERT_BATCH_SIZE);
  };
  await insertFrom(0);
  return insertedRunIds;
};

/**
 * Commit the durable extraction request with the mutation that creates its
 * source file, so no crash can land the file without the request.
 *
 * The row is exactly the shape `document_processing_runs_native_extraction_insert`
 * admits for a scoped transaction: a queued, unattributed, upload-sourced
 * native-extraction request for a workspace the transaction already holds.
 * Everything after the insert (queue handoff, retries, state transitions)
 * remains root-writer work. Callers enqueue the returned run id after commit,
 * or call `processExtraction` when they do not retain it, to accelerate what
 * this row already guarantees.
 *
 * Returns the run id this transaction created, or `null` when the entity needs
 * no durable extraction or an equivalent run already exists.
 */
export const requestNativeExtractionRun = async ({
  entityId,
  filePropertyId,
  tx,
}: {
  entityId: SafeId<"entity">;
  filePropertyId?: SafeId<"property"> | undefined;
  tx: Transaction;
}): Promise<SafeId<"documentProcessingRun"> | null> => {
  const entity = await readExtractionEntity(tx, entityId);
  if (!entity) {
    return null;
  }
  const source = resolveNativeExtractionSource(
    entityId,
    entity,
    filePropertyId,
  );
  if (!source) {
    return null;
  }
  const inserted = await requestNativeExtractionRuns({
    requests: [source],
    tx,
  });
  return inserted.at(0) ?? null;
};

/**
 * Durably request native extraction for the entity's selected file. The
 * document-processing worker owns extraction, persistence, indexing, and
 * retries; callers may still treat this as best-effort because the committed
 * run and bounded repair scan own eventual completion.
 */
export const processExtraction = async (
  entityId: SafeId<"entity">,
  options?: {
    filePropertyId?: SafeId<"property"> | undefined;
  },
  {
    database = rootDb,
    enqueueRun = enqueueDocumentProcessingRun,
    indexEntity = async (id) => await getSearchProvider().indexEntity(id),
  }: ProcessExtractionDependencies = {},
): Promise<void> => {
  const entity = await readExtractionEntity(database, entityId);

  if (!entity) {
    return;
  }

  const source = resolveNativeExtractionSource(
    entityId,
    entity,
    options?.filePropertyId,
  );
  if (!source) {
    await indexEntity(entityId);
    return;
  }

  const { entityVersionId, fieldId, fileField, organizationId, workspaceId } =
    source;
  const inserted = await database
    .insert(documentProcessingRuns)
    .values(nativeExtractionRunValues(source))
    .onConflictDoNothing({ target: NATIVE_EXTRACTION_SOURCE_TARGET })
    .returning({ id: documentProcessingRuns.id });
  const created = inserted.at(0);
  if (created) {
    await enqueueRun(created.id);
    return;
  }
  const existing = (
    await database
      .select({
        id: documentProcessingRuns.id,
        status: documentProcessingRuns.status,
      })
      .from(documentProcessingRuns)
      .where(
        and(
          eq(documentProcessingRuns.organizationId, organizationId),
          eq(documentProcessingRuns.workspaceId, workspaceId),
          eq(documentProcessingRuns.entityId, entityId),
          eq(documentProcessingRuns.entityVersionId, entityVersionId),
          eq(documentProcessingRuns.fieldId, fieldId),
          eq(documentProcessingRuns.sourceFileId, fileField.id),
          eq(documentProcessingRuns.sourceSha256Hex, fileField.sha256Hex),
          eq(
            documentProcessingRuns.kind,
            SCOPED_NATIVE_EXTRACTION_ENQUEUE.kind,
          ),
          eq(
            documentProcessingRuns.processorVersion,
            DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
          ),
        ),
      )
      .limit(1)
  ).at(0);
  if (!existing) {
    return;
  }
  if (existing.status === "queued") {
    await enqueueRun(existing.id);
    return;
  }
  if (existing.status !== "succeeded") {
    return;
  }

  const projection = await database.query.extractedContent.findFirst({
    where: {
      entityId: { eq: entityId },
      organizationId: { eq: organizationId },
      sourceEntityVersionId: { eq: entityVersionId },
      sourceFieldId: { eq: fieldId },
      sourceFileId: { eq: fileField.id },
      sourceSha256Hex: { eq: fileField.sha256Hex },
      workspaceId: { eq: workspaceId },
    },
    columns: { entityId: true },
  });
  if (projection) {
    // The durable extraction still matches; rebuild a projection that may
    // have been deliberately removed during version rollback.
    await indexEntity(entityId);
    return;
  }

  // The unique run belongs to this immutable source, but its succeeded
  // projection was replaced by a later version. Requeue it conditionally so
  // rollback can reconstruct the promoted version without racing a worker.
  const requeued = await database
    .update(documentProcessingRuns)
    .set({
      claimedAt: null,
      claimedBy: null,
      errorAt: null,
      errorCode: null,
      finishedAt: null,
      nextAttemptAt: null,
      progressCompleted: 0,
      progressTotal: null,
      startedAt: null,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, existing.id),
        eq(documentProcessingRuns.status, "succeeded"),
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  const retry = requeued.at(0);
  if (retry) {
    await enqueueRun(retry.id);
  }
};

export type ProcessExtractionDependencies = {
  database?: Pick<typeof rootDb, "insert" | "query" | "select" | "update">;
  enqueueRun?: typeof enqueueDocumentProcessingRun;
  indexEntity?: (entityId: SafeId<"entity">) => Promise<void>;
};
