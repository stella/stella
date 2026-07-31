import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { mockS3Module } from "@/api/tests/helpers/mock-s3";

// `processExtraction` reads through the `rootDb` module-level singleton
// directly (no injected `safeDb`), so the query call is captured by mocking
// that module, matching the established pattern (see
// apps/api/src/lib/folio-collab-sessions.test.ts). Resolving `findFirst`
// with `null` (entity not found) short-circuits the function right after
// the query, before it would otherwise reach S3/search-provider calls this
// test does not need to stub.
const entityId = toSafeId<"entity">("entity_1");
const entityVersionId = toSafeId<"entityVersion">("entity_version_1");
const fieldId = toSafeId<"field">("field_1");
const propertyId = toSafeId<"property">("property_1");
const organizationId = toSafeId<"organization">("org_1");
const workspaceId = toSafeId<"workspace">("workspace_1");
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
const arrayBufferMock = mock(async () => new ArrayBuffer(8));
const getS3Mock = mock(() => ({
  file: () => ({ arrayBuffer: arrayBufferMock }),
}));
const extractFileTextMock = mock(
  async (): Promise<string | null> => "native text",
);
const encryptContentMock = mock(async () => ({
  ciphertext: Buffer.from("ciphertext"),
  iv: Buffer.from("iv"),
}));
const requestAutomaticDocumentOcrMock = mock(async () => undefined);
const indexEntityMock = mock(async () => undefined);

void mock.module("@/api/db/root", () => ({
  rootDb: {
    execute: executeMock,
    query: { entities: { findFirst: findFirstMock } },
    transaction: transactionMock,
  },
}));
void mock.module("@/api/lib/content-encryption", () => ({
  encryptContent: encryptContentMock,
}));
void mock.module("@/api/lib/document-processing-automatic-request", () => ({
  requestAutomaticDocumentOcr: requestAutomaticDocumentOcrMock,
}));
void mock.module("@/api/lib/s3", () => mockS3Module({ getS3: getS3Mock }));
void mock.module("@/api/lib/search/extract-content", () => ({
  extractFileText: extractFileTextMock,
  resolveExtractionMimeType: ({ mimeType }: { mimeType: string }) => mimeType,
}));
void mock.module("@/api/lib/search/provider", () => ({
  getSearchProvider: () => ({ indexEntity: indexEntityMock }),
}));

const { persistNativeExtractionProjection, processExtraction } =
  await import("@/api/lib/search/process-extraction");

beforeEach(() => {
  findFirstResult = null;
  findFirstMock.mockClear();
  executeMock.mockReset();
  executeMock.mockImplementation(async (_query: SQL) => [{ entityId }]);
  transactionMock.mockClear();
  arrayBufferMock.mockClear();
  getS3Mock.mockClear();
  extractFileTextMock.mockReset();
  extractFileTextMock.mockImplementation(async () => "native text");
  encryptContentMock.mockReset();
  encryptContentMock.mockImplementation(async () => ({
    ciphertext: Buffer.from("ciphertext"),
    iv: Buffer.from("iv"),
  }));
  requestAutomaticDocumentOcrMock.mockClear();
  indexEntityMock.mockClear();
});

describe("processExtraction", () => {
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

  test("requests OCR when native PDF extraction yields no text", async () => {
    findFirstResult = extractionEntity;
    extractFileTextMock.mockImplementationOnce(async () => null);

    await processExtraction(entityId);

    expect(requestAutomaticDocumentOcrMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId,
        entityVersionId,
        fieldId,
        sourceFileId: fileContent.id,
      }),
    );
    expect(encryptContentMock).not.toHaveBeenCalled();
    expect(indexEntityMock).toHaveBeenCalledWith(entityId);
  });

  test("propagates encryption failure without sending readable text to OCR", async () => {
    findFirstResult = extractionEntity;
    const encryptionError = new Error("encryption unavailable");
    encryptContentMock.mockImplementationOnce(async () => {
      throw encryptionError;
    });

    const rejection: unknown = await processExtraction(entityId).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(encryptionError);
    expect(requestAutomaticDocumentOcrMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(indexEntityMock).not.toHaveBeenCalled();
  });

  test("propagates projection failure without sending readable text to OCR", async () => {
    findFirstResult = extractionEntity;
    const persistenceError = new Error("database unavailable");
    executeMock
      .mockResolvedValueOnce([{ entityId }])
      .mockImplementationOnce(async () => {
        throw persistenceError;
      });

    const rejection: unknown = await processExtraction(entityId).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(persistenceError);
    expect(encryptContentMock).toHaveBeenCalled();
    expect(requestAutomaticDocumentOcrMock).not.toHaveBeenCalled();
    expect(indexEntityMock).not.toHaveBeenCalled();
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

    expect(persisted).toBe(true);
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

    expect(persisted).toBe(false);
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

    expect(persisted).toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
});
