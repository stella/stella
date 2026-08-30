import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { rootDb } from "@/api/db/root";
import type { FieldContent } from "@/api/db/schema-validators";
import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import {
  EXTRACTION_WORKER_ERROR_CODE,
  ExtractionWorkerError,
} from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  executeNativeExtraction as executeNativeExtractionWithDependencies,
  persistNativeExtractionProjection as persistNativeExtractionProjectionWithDatabase,
  processExtraction as processExtractionWithDependencies,
  requiresDurableNativeExtraction,
} from "@/api/lib/search/process-extraction";
import type {
  ExecuteNativeExtractionDependencies,
  ProcessExtractionDependencies,
} from "@/api/lib/search/process-extraction";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const entityId = toSafeId<"entity">("entity_1");
const entityVersionId = toSafeId<"entityVersion">("entity_version_1");
const fieldId = toSafeId<"field">("field_1");
const propertyId = toSafeId<"property">("property_1");
const organizationId = toSafeId<"organization">("org_1");
const workspaceId = toSafeId<"workspace">("workspace_1");
const runId = toSafeId<"documentProcessingRun">("run_1");
const fileContent = {
  encrypted: false,
  fileName: "readable.pdf",
  id: "file_1",
  mimeType: PDF_MIME_TYPE,
  pdfFileId: null,
  sha256Hex: "a".repeat(64),
  sizeBytes: 128,
  type: "file",
  version: 1,
} satisfies FieldContent;
const extractionEntity = {
  currentVersion: {
    fields: [{ content: fileContent, id: fieldId, propertyId }],
    id: entityVersionId,
  },
  id: entityId,
  workspace: { id: workspaceId, organizationId },
  workspaceId,
};
let findFirstResult: typeof extractionEntity | null = null;
const findFirstMock = mock(async () => findFirstResult);
const executeMock = mock(async (_query: SQL) => [{ entityId }]);
const transactionMock = mock(
  async (
    runTransaction: (tx: { execute: typeof executeMock }) => Promise<unknown>,
  ) => await runTransaction({ execute: executeMock }),
);
const returningMock = mock(async () => [{ id: runId }]);
const onConflictDoNothingMock = mock(() => ({ returning: returningMock }));
const valuesMock = mock(() => ({
  onConflictDoNothing: onConflictDoNothingMock,
}));
const insertMock = mock(() => ({ values: valuesMock }));
let existingRuns: { id: typeof runId; status: "queued" | "succeeded" }[] = [];
const selectLimitMock = mock(async () => existingRuns);
const selectWhereMock = mock(() => ({ limit: selectLimitMock }));
const selectFromMock = mock(() => ({ where: selectWhereMock }));
const selectMock = mock(() => ({ from: selectFromMock }));
let extractedProjection: { entityId: typeof entityId } | null = null;
const extractedContentFindFirstMock = mock(async () => extractedProjection);
const updateReturningMock = mock(async () => [{ id: runId }]);
const updateWhereMock = mock(() => ({ returning: updateReturningMock }));
const updateSetMock = mock(() => ({ where: updateWhereMock }));
const updateMock = mock(() => ({ set: updateSetMock }));
const extractFileTextResultMock = mock(
  async (
    _buffer: ArrayBuffer,
    _mimeType: string,
    _options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result<string | null, ExtractionWorkerError>> =>
    Result.ok("native text"),
);
const requestAutomaticDocumentOcrMock = mock(async () => undefined);
const restoreManualOcrRunAfterProjectionLossMock = mock(async () => undefined);
const enqueueDocumentProcessingRunMock = mock(async () => undefined);
const indexEntityMock = mock(async () => undefined);

const database = asTestRaw<
  NonNullable<ProcessExtractionDependencies["database"]>
>({
  insert: insertMock,
  query: {
    entities: { findFirst: findFirstMock },
    extractedContent: { findFirst: extractedContentFindFirstMock },
  },
  select: selectMock,
  transaction: transactionMock,
  update: updateMock,
});
const transactionDatabase = asTestRaw<Pick<typeof rootDb, "transaction">>({
  transaction: transactionMock,
});

const persistNativeExtractionProjection: typeof persistNativeExtractionProjectionWithDatabase =
  async (options) =>
    await persistNativeExtractionProjectionWithDatabase(
      options,
      transactionDatabase,
    );

const executeDependencies = {
  extractText: extractFileTextResultMock,
  persistProjection: persistNativeExtractionProjection,
  requestAutomaticOcr: requestAutomaticDocumentOcrMock,
  restoreManualOcr: restoreManualOcrRunAfterProjectionLossMock,
} satisfies ExecuteNativeExtractionDependencies;

const executeNativeExtraction: typeof executeNativeExtractionWithDependencies =
  async (input) =>
    await executeNativeExtractionWithDependencies({
      ...input,
      dependencies: executeDependencies,
    });

const processExtraction: typeof processExtractionWithDependencies = async (
  targetEntityId,
  options,
) =>
  await processExtractionWithDependencies(targetEntityId, options, {
    database,
    enqueueRun: enqueueDocumentProcessingRunMock,
    indexEntity: indexEntityMock,
  });

// The bytes the extraction is expected to hand the extractor, and the keys
// they are stored under. Written out rather than derived through
// `createFileKey`, so the test states the key independently of the code that
// builds it.
const SOURCE_BYTES = "source document bytes";
const sourceKey = (extension: string): string =>
  `${organizationId}/${workspaceId}/${fileContent.id}.${extension}`;

let fake: FakeS3;

const seedSource = (extension: string): string => {
  const key = sourceKey(extension);
  fake.put(envBase.S3_BUCKET, key, SOURCE_BYTES, "application/octet-stream");
  return key;
};

const objectReadKeys = (): string[] =>
  fake.requests
    .filter(({ method }) => method === "GET" || method === "HEAD")
    .map(({ key }) => key);

type PersistedProjection = {
  /** What a reader recovers: the bound envelope, decrypted under the org key. */
  text: string;
  ciphertext: Buffer;
  iv: Buffer;
};

/**
 * The projection the write statement carries. The two `bytea` parameters are
 * the ciphertext and IV, in that order; everything else the statement binds is
 * an id, a count or a hash.
 */
const persistedProjection = async (): Promise<PersistedProjection> => {
  const writeQuery = executeMock.mock.calls.at(1)?.[0];
  if (writeQuery === undefined) {
    throw new Error("no projection write statement was executed");
  }
  const buffers = new PgDialect()
    .sqlToQuery(writeQuery)
    .params.filter((param) => Buffer.isBuffer(param));
  const ciphertext = buffers.at(0);
  const iv = buffers.at(1);
  if (ciphertext === undefined || iv === undefined) {
    throw new Error("the projection write bound no ciphertext and IV");
  }
  return {
    text: await decryptContent(organizationId, ciphertext, iv),
    ciphertext,
    iv,
  };
};

beforeEach(() => {
  fake = startFakeS3();
  findFirstResult = null;
  findFirstMock.mockClear();
  executeMock.mockReset();
  executeMock.mockImplementation(async (_query: SQL) => [{ entityId }]);
  transactionMock.mockClear();
  insertMock.mockClear();
  valuesMock.mockClear();
  onConflictDoNothingMock.mockClear();
  returningMock.mockReset();
  returningMock.mockImplementation(async () => [{ id: runId }]);
  existingRuns = [];
  extractedProjection = null;
  selectMock.mockClear();
  selectFromMock.mockClear();
  selectWhereMock.mockClear();
  selectLimitMock.mockClear();
  extractedContentFindFirstMock.mockClear();
  updateMock.mockClear();
  updateSetMock.mockClear();
  updateWhereMock.mockClear();
  updateReturningMock.mockReset();
  updateReturningMock.mockImplementation(async () => [{ id: runId }]);
  extractFileTextResultMock.mockReset();
  extractFileTextResultMock.mockImplementation(async () =>
    Result.ok("native text"),
  );
  requestAutomaticDocumentOcrMock.mockClear();
  restoreManualOcrRunAfterProjectionLossMock.mockClear();
  enqueueDocumentProcessingRunMock.mockClear();
  indexEntityMock.mockClear();
});

afterEach(() => {
  fake.stop();
});

describe("processExtraction", () => {
  // Files with a pending PDF derivative wait for it so extraction reads the
  // rendered PDF rather than the original bytes.
  test("requires durable extraction only after any pending PDF derivative exists", () => {
    expect(requiresDurableNativeExtraction(fileContent)).toBe(true);
    expect(
      requiresDurableNativeExtraction({
        ...fileContent,
        fileName: "contract.docx",
        mimeType: DOCX_MIME_TYPE,
      }),
    ).toBe(true);
    expect(
      requiresDurableNativeExtraction({
        ...fileContent,
        fileName: "notes.txt",
        mimeType: "text/plain",
      }),
    ).toBe(false);
    expect(
      requiresDurableNativeExtraction({
        ...fileContent,
        fileName: "notes.txt",
        mimeType: "text/plain",
        pdfFileId: "derived_pdf_1",
      }),
    ).toBe(true);
  });

  test("orders the current version's fields by id, matching readEntityByIdHandler, so 'first file field' selection is deterministic", async () => {
    await processExtraction(entityId);

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        with: expect.objectContaining({
          currentVersion: expect.objectContaining({
            with: expect.objectContaining({
              // The `fields` table has no createdAt/position column; `id`
              // is a Bun.randomUUIDv7() primary key (time-ordered), so
              // ordering by it is the only way to get a stable "first
              // field" across repeated reads. `readEntityByIdHandler`
              // (handlers/entities/get.ts) MUST request the exact same
              // ordering on the same relation, or `findExtractionFileField`
              // could resolve to a different "first" field there than it
              // does here.
              fields: expect.objectContaining({
                orderBy: { id: "asc" },
              }),
            }),
          }),
        }),
      }),
    );
  });

  test("commits and enqueues a durable native run before extraction", async () => {
    findFirstResult = extractionEntity;

    await processExtraction(entityId);

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId,
        entityVersionId,
        fieldId,
        kind: "native-extraction",
        sourceFileId: fileContent.id,
      }),
    );
    expect(enqueueDocumentProcessingRunMock).toHaveBeenCalledWith(runId);
    expect(extractFileTextResultMock).not.toHaveBeenCalled();
    expect(requestAutomaticDocumentOcrMock).not.toHaveBeenCalled();
    expect(indexEntityMock).not.toHaveBeenCalled();
  });

  test("requeues a succeeded native run when rollback removed its projection", async () => {
    findFirstResult = extractionEntity;
    returningMock.mockImplementationOnce(async () => []);
    existingRuns = [{ id: runId, status: "succeeded" }];

    await processExtraction(entityId);

    expect(extractedContentFindFirstMock).toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", finishedAt: null }),
    );
    expect(enqueueDocumentProcessingRunMock).toHaveBeenCalledWith(runId);
    expect(indexEntityMock).not.toHaveBeenCalled();
  });

  test("reindexes a succeeded native projection without repeating extraction", async () => {
    findFirstResult = extractionEntity;
    returningMock.mockImplementationOnce(async () => []);
    existingRuns = [{ id: runId, status: "succeeded" }];
    extractedProjection = { entityId };

    await processExtraction(entityId);

    expect(indexEntityMock).toHaveBeenCalledWith(entityId);
    expect(updateMock).not.toHaveBeenCalled();
    expect(enqueueDocumentProcessingRunMock).not.toHaveBeenCalled();
  });

  test("keeps a sandbox failure distinct from a valid empty document", async () => {
    const workerError = new ExtractionWorkerError({
      code: EXTRACTION_WORKER_ERROR_CODE.parser,
      exitCode: 1,
      message: "sandbox crashed",
      mimeType: fileContent.mimeType,
      sizeBytes: fileContent.sizeBytes,
      termination: null,
    });
    extractFileTextResultMock.mockImplementationOnce(async () =>
      Result.err(workerError),
    );
    const lifecycleSignal = new AbortController().signal;
    const key = seedSource("pdf");

    const rejection: unknown = await executeNativeExtraction({
      fileField: fileContent,
      lifecycleSignal,
      run: {
        entityId,
        entityVersionId,
        fieldId,
        organizationId,
        sourceFileId: fileContent.id,
        sourceSha256Hex: fileContent.sha256Hex,
        workspaceId,
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(workerError);
    // The extractor is handed the object the run's file identity names, read
    // from storage rather than handed in by the test.
    expect(objectReadKeys()).toEqual([key]);
    expect(extractFileTextResultMock).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      fileContent.mimeType,
      {
        signal: lifecycleSignal,
        timeoutMs: LIMITS.documentProcessingExtractionTimeoutMs,
      },
    );
    const extracted = extractFileTextResultMock.mock.calls.at(0)?.[0];
    expect(
      extracted === undefined ? null : new TextDecoder().decode(extracted),
    ).toBe(SOURCE_BYTES);
    // A sandbox failure is terminal: nothing is encrypted and nothing is
    // written, so no projection statement runs at all.
    expect(requestAutomaticDocumentOcrMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  test("persists a valid empty DOCX as a terminal zero-length projection", async () => {
    const docxContent = {
      ...fileContent,
      fileName: "empty.docx",
      mimeType: DOCX_MIME_TYPE,
    } satisfies FieldContent;
    extractFileTextResultMock.mockImplementationOnce(async () =>
      Result.ok(null),
    );
    const key = seedSource("docx");

    const outcome = await executeNativeExtraction({
      fileField: docxContent,
      lifecycleSignal: new AbortController().signal,
      run: {
        entityId,
        entityVersionId,
        fieldId,
        organizationId,
        sourceFileId: docxContent.id,
        sourceSha256Hex: docxContent.sha256Hex,
        workspaceId,
      },
    });

    expect(outcome).toBe("persisted");
    expect(objectReadKeys()).toEqual([key]);
    // A document with no text still stores an encrypted empty string, not a
    // plaintext one: the column shape is the same as any other projection's.
    const projection = await persistedProjection();
    expect(projection.text).toBe("");
    expect(projection.iv.every((byte) => byte === 0)).toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(requestAutomaticDocumentOcrMock).not.toHaveBeenCalled();
    expect(restoreManualOcrRunAfterProjectionLossMock).not.toHaveBeenCalled();
  });

  test("reads native extraction input through the caller-provided storage scope", async () => {
    const readSource = mock(async () => new ArrayBuffer(8));

    await executeNativeExtraction({
      fileField: fileContent,
      lifecycleSignal: new AbortController().signal,
      readSource,
      run: {
        entityId,
        entityVersionId,
        fieldId,
        organizationId,
        sourceFileId: fileContent.id,
        sourceSha256Hex: fileContent.sha256Hex,
        workspaceId,
      },
    });

    expect(readSource).toHaveBeenCalledWith(
      `${organizationId}/${workspaceId}/${fileContent.id}.pdf`,
      expect.any(AbortSignal),
    );
    // The provided scope replaces the default reader outright: the store sees
    // no request at all.
    expect(fake.requests).toEqual([]);
  });

  test("propagates lifecycle cancellation to the caller-provided storage reader", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<undefined>();
    const observedSignals: AbortSignal[] = [];
    const readSource = mock(async (_key: string, signal: AbortSignal) => {
      observedSignals.push(signal);
      started.resolve(undefined);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Storage read aborted")),
          {
            once: true,
          },
        );
      });
      return new ArrayBuffer();
    });

    const extraction = executeNativeExtraction({
      fileField: fileContent,
      lifecycleSignal: controller.signal,
      readSource,
      run: {
        entityId,
        entityVersionId,
        fieldId,
        organizationId,
        sourceFileId: fileContent.id,
        sourceSha256Hex: fileContent.sha256Hex,
        workspaceId,
      },
    });
    await started.promise;
    controller.abort("test cancellation");
    const rejection = await extraction.then(
      () => null,
      (error: unknown) => error,
    );

    expect(observedSignals).toHaveLength(1);
    expect(observedSignals.at(0)?.aborted).toBe(true);
    expect(rejection).not.toBeNull();
    expect(fake.requests).toEqual([]);
    // A cancelled read never reaches encryption or the projection write.
    expect(executeMock).not.toHaveBeenCalled();
  });

  test("restores manual OCR after native PDF extraction without automatic eligibility", async () => {
    const key = seedSource("pdf");

    const outcome = await executeNativeExtraction({
      fileField: fileContent,
      lifecycleSignal: new AbortController().signal,
      run: {
        entityId,
        entityVersionId,
        fieldId,
        organizationId,
        sourceFileId: fileContent.id,
        sourceSha256Hex: fileContent.sha256Hex,
        workspaceId,
      },
    });

    expect(outcome).toBe("persisted");
    expect(objectReadKeys()).toEqual([key]);
    // The extracted text reaches the projection as ciphertext only a reader
    // holding the organization's key can turn back into the document: the
    // stored bytes are not the text, and the IV is not the plaintext envelope.
    const projection = await persistedProjection();
    expect(projection.text).toBe("native text");
    expect(projection.ciphertext.toString("utf-8")).not.toBe("native text");
    expect(projection.iv.every((byte) => byte === 0)).toBe(false);
    expect(restoreManualOcrRunAfterProjectionLossMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId,
        fieldId,
        sourceFileId: fileContent.id,
      }),
    );
    expect(requestAutomaticDocumentOcrMock).not.toHaveBeenCalled();
  });

  test("requests OCR for a textless extension-resolved PDF", async () => {
    const extensionResolvedPdf = {
      ...fileContent,
      fileName: "scan.pdf",
      mimeType: "application/octet-stream",
    } satisfies FieldContent;
    extractFileTextResultMock.mockImplementationOnce(async () =>
      Result.ok(null),
    );
    // Stored under the declared generic type; only the extraction type is
    // resolved from the filename.
    const key = seedSource("bin");

    const outcome = await executeNativeExtraction({
      fileField: extensionResolvedPdf,
      lifecycleSignal: new AbortController().signal,
      run: {
        entityId,
        entityVersionId,
        fieldId,
        organizationId,
        sourceFileId: extensionResolvedPdf.id,
        sourceSha256Hex: extensionResolvedPdf.sha256Hex,
        workspaceId,
      },
    });

    expect(outcome).toBe("persisted");
    expect(objectReadKeys()).toEqual([key]);
    expect(restoreManualOcrRunAfterProjectionLossMock).toHaveBeenCalled();
    expect(requestAutomaticDocumentOcrMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId,
        fieldId,
        sourceFileId: extensionResolvedPdf.id,
      }),
    );
  });

  test("serializes native persistence and fences a current manual OCR selection", async () => {
    const sourceVersionId = toSafeId<"entityVersion">(
      "019864b8-48d0-7f37-94d5-948e3bcf3f45",
    );
    const sourceFieldId = toSafeId<"field">(
      "019864b8-48d0-7f37-94d5-948e3bcf3f46",
    );
    const sourceFileId = "019864b8-48d0-7f37-94d5-948e3bcf3f44";
    const sourceSha256Hex = "a".repeat(64);

    const persisted = await persistNativeExtractionProjection({
      charCount: 14,
      ciphertext: Buffer.from("ciphertext"),
      entityId: toSafeId<"entity">("entity_1"),
      entityVersionId: sourceVersionId,
      fieldId: sourceFieldId,
      iv: Buffer.from("iv"),
      organizationId: toSafeId<"organization">("org_1"),
      sourceFileId,
      sourceSha256Hex,
      workspaceId: toSafeId<"workspace">("workspace_1"),
    });

    expect(persisted).toBe("persisted");
    const lockQuery = executeMock.mock.calls.at(0)?.[0];
    const writeQuery = executeMock.mock.calls.at(1)?.[0];
    expect(lockQuery).toBeDefined();
    expect(writeQuery).toBeDefined();
    if (!(lockQuery && writeQuery)) {
      return;
    }
    const compiledLock = new PgDialect().sqlToQuery(lockQuery);
    expect(compiledLock.sql).toContain("e.current_version_id =");
    expect(compiledLock.sql).toContain("f.entity_version_id =");
    expect(compiledLock.sql).toContain("f.content->>'id' =");
    expect(compiledLock.sql).toContain("f.content->>'sha256Hex' =");
    expect(compiledLock.sql).toContain("FOR UPDATE OF e");
    const compiledWrite = new PgDialect().sqlToQuery(writeQuery);
    expect(compiledWrite.sql).toContain(
      "WITH manual_projection_ownership AS MATERIALIZED",
    );
    expect(compiledWrite.sql).toContain("manual_run.entity_version_id =");
    expect(compiledWrite.sql).toContain(
      "manual_run.status IN ('queued', 'running')",
    );
    expect(compiledWrite.sql).toContain(
      "selected_projection.source_entity_version_id = manual_run.entity_version_id",
    );
    expect(compiledWrite.sql).toContain(
      "selected_projection.source_field_id = manual_run.field_id",
    );
    expect(compiledWrite.sql).toContain(
      "selected_projection.source_file_id = manual_run.source_file_id",
    );
    expect(compiledWrite.sql).toContain(
      "selected_projection.source_sha256_hex = manual_run.source_sha256_hex",
    );
    expect(compiledWrite.sql).toContain("manual_run.status = 'succeeded'");
    expect(compiledWrite.sql).toContain(
      "manual_run.error_code = 'search_index_failed'",
    );
    expect(
      compiledWrite.sql.match(/manual_projection_ownership/gu),
    ).toHaveLength(3);
    expect(compiledWrite.params).toContain(sourceVersionId);
    expect(compiledWrite.params).toContain(sourceFieldId);
    expect(compiledWrite.params).toContain(sourceFileId);
    expect(compiledWrite.params).toContain(sourceSha256Hex);
  });

  test("does not overwrite a newer projection after its source is replaced", async () => {
    executeMock.mockResolvedValueOnce([]);

    const persisted = await persistNativeExtractionProjection({
      charCount: 14,
      ciphertext: Buffer.from("stale ciphertext"),
      entityId: toSafeId<"entity">("entity_1"),
      entityVersionId: toSafeId<"entityVersion">(
        "019864b8-48d0-7f37-94d5-948e3bcf3f45",
      ),
      fieldId: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f46"),
      iv: Buffer.from("stale iv"),
      organizationId: toSafeId<"organization">("org_1"),
      sourceFileId: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
      sourceSha256Hex: "a".repeat(64),
      workspaceId: toSafeId<"workspace">("workspace_1"),
    });

    expect(persisted).toBe("source_cancelled");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("reports that the ownership-fenced native projection was not persisted", async () => {
    executeMock.mockResolvedValueOnce([{ entityId }]).mockResolvedValueOnce([]);

    const persisted = await persistNativeExtractionProjection({
      charCount: 14,
      ciphertext: Buffer.from("native ciphertext"),
      entityId: toSafeId<"entity">("entity_1"),
      entityVersionId: toSafeId<"entityVersion">(
        "019864b8-48d0-7f37-94d5-948e3bcf3f45",
      ),
      fieldId: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f46"),
      iv: Buffer.from("native iv"),
      organizationId: toSafeId<"organization">("org_1"),
      sourceFileId: "019864b8-48d0-7f37-94d5-948e3bcf3f44",
      sourceSha256Hex: "a".repeat(64),
      workspaceId: toSafeId<"workspace">("workspace_1"),
    });

    expect(persisted).toBe("preserved");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  test("surfaces preserved manual OCR ownership and skips automatic fallback", async () => {
    executeMock.mockResolvedValueOnce([{ entityId }]).mockResolvedValueOnce([]);
    extractFileTextResultMock.mockImplementationOnce(async () =>
      Result.ok(null),
    );
    seedSource("pdf");

    const outcome = await executeNativeExtraction({
      fileField: fileContent,
      lifecycleSignal: new AbortController().signal,
      run: {
        entityId,
        entityVersionId,
        fieldId,
        organizationId,
        sourceFileId: fileContent.id,
        sourceSha256Hex: fileContent.sha256Hex,
        workspaceId,
      },
    });

    expect(outcome).toBe("preserved");
    expect(restoreManualOcrRunAfterProjectionLossMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId,
        fieldId,
        sourceFileId: fileContent.id,
      }),
    );
    expect(requestAutomaticDocumentOcrMock).not.toHaveBeenCalled();
  });
});
