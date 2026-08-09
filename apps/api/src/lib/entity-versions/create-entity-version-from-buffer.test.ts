import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { bufferObjectCleanupIntents, workspaces } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const writeFileVersionMock = mock();
const s3WriteMock = mock();
const s3DeleteMock = mock();
const processExtractionMock = mock();
const pdfDerivativeMock = mock();
const thumbnailDerivativeMock = mock();
const diffStatsMock = mock();
const broadcastMock = mock();
let persistenceEvents: string[] = [];
let intentStatuses: string[] = [];

const realS3 = await import("@/api/lib/s3");

void mock.module("@/api/lib/entity-versions/write-file-version", () => ({
  writeFileVersion: writeFileVersionMock,
}));
void mock.module("@/api/lib/files/file-object-ids", () => ({
  allocateFileObject: () => "file_1",
}));
void mock.module("@/api/lib/files/utils", () => ({
  createFileKey: () => "org_1/ws_1/file_1.docx",
}));
void mock.module("@/api/lib/s3", () => ({
  ...realS3,
  deleteS3ObjectWithSignal: s3DeleteMock,
  putS3ObjectWithSignal: s3WriteMock,
  // `mock.module` replaces the module, so every named export a consumer
  // imports must exist here or the import fails at link time. This suite
  // reads no object; throwing surfaces one that appears later.
  readS3ArrayBuffer: () => {
    throw new Error("Unexpected S3 object read in this suite");
  },
  readCorpusS3Bytes: () => {
    throw new Error("Unexpected corpus object read in this suite");
  },
}));
void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
}));
void mock.module("@/api/lib/file-derivative-queue", () => ({
  enqueuePdfDerivativeOrMarkFailed: pdfDerivativeMock,
  enqueueImageThumbnailOrMarkFailed: thumbnailDerivativeMock,
}));
void mock.module("@/api/lib/entity-versions/compute-version-diff", () => ({
  computeVersionDiffStats: diffStatsMock,
}));
void mock.module("@/api/lib/root-scoped-db", () => ({
  createRootScopedDb: () => mock(),
}));
void mock.module("@/api/lib/sse", () => ({ broadcast: broadcastMock }));
void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: mock(),
  captureRequestError: mock(),
  getAnalytics: () => ({ capture: mock(), flush: mock() }),
}));

const { createEntityVersionFromBuffer } =
  await import("@/api/lib/entity-versions/create-entity-version-from-buffer");

const createTestTransaction = (): Transaction =>
  asTestRaw<Transaction>({
    delete: (table: unknown) => {
      if (table === bufferObjectCleanupIntents) {
        return { where: async () => undefined };
      }
      throw new Error("Unexpected delete table");
    },
    insert: () => ({
      values: (values: { id: string; status?: string }) => {
        persistenceEvents.push("intent-reserved");
        if (values.status) {
          intentStatuses.push(values.status);
        }
        return {
          returning: async () => [{ id: values.id }],
        };
      },
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => ({
            for: async () =>
              table === workspaces ? [{ status: "active" }] : [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: { status?: string }) => {
        if (values.status) {
          intentStatuses.push(values.status);
        }
        return {
          where: () => ({
            returning: async () => [{ id: "intent_1" }],
          }),
        };
      },
    }),
  });

const safeDb = asTestRaw<SafeDb>(
  async <T>(run: (tx: Transaction) => Promise<T>) =>
    await Result.tryPromise({
      try: async () => await run(createTestTransaction()),
      catch: (cause) => cause,
    }),
);
const recordAuditEvent = asTestRaw<AuditRecorder>(async () => undefined);
const baseInput = {
  safeDb,
  organizationId: toSafeId<"organization">("org_1"),
  workspaceId: toSafeId<"workspace">("ws_1"),
  entityId: toSafeId<"entity">("entity_1"),
  userId: toSafeId<"user">("user_1"),
  recordAuditEvent,
  buffer: Buffer.from("filled docx"),
  fileName: "filled.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  source: null,
  writePolicy: { type: "replace-current-file" as const },
};

describe("createEntityVersionFromBuffer", () => {
  beforeEach(() => {
    for (const fn of [
      writeFileVersionMock,
      s3WriteMock,
      s3DeleteMock,
      processExtractionMock,
      pdfDerivativeMock,
      thumbnailDerivativeMock,
      diffStatsMock,
      broadcastMock,
    ]) {
      fn.mockReset();
    }
    s3WriteMock.mockResolvedValue(undefined);
    s3WriteMock.mockImplementation(async () => {
      persistenceEvents.push("s3-written");
    });
    s3DeleteMock.mockResolvedValue(undefined);
    processExtractionMock.mockResolvedValue(undefined);
    pdfDerivativeMock.mockResolvedValue(undefined);
    thumbnailDerivativeMock.mockResolvedValue(undefined);
    diffStatsMock.mockResolvedValue(undefined);
    persistenceEvents = [];
    intentStatuses = [];
  });

  test("rejects oversized documents before object storage or the transaction", async () => {
    const result = await createEntityVersionFromBuffer({
      ...baseInput,
      buffer: new Uint8Array(FILE_SIZE_LIMIT_BYTES.document + 1),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toEqual(
        expect.objectContaining({
          code: "document-too-large",
          message: `Document exceeds the ${FILE_SIZE_LIMIT_BYTES.document}-byte size limit`,
        }),
      );
    }
    expect(s3WriteMock).not.toHaveBeenCalled();
    expect(writeFileVersionMock).not.toHaveBeenCalled();
    expect(s3DeleteMock).not.toHaveBeenCalled();
  });

  test("keeps recovery after deleting an ambiguous initial write", async () => {
    const writeError = new Error("object storage timed out");
    s3WriteMock.mockRejectedValue(writeError);

    const attempted = await Result.tryPromise({
      try: async () => await createEntityVersionFromBuffer(baseInput),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error).toBe(writeError);
    }
    expect(s3DeleteMock).toHaveBeenCalledWith(
      "org_1/ws_1/file_1.docx",
      expect.any(AbortSignal),
    );
    expect(writeFileVersionMock).not.toHaveBeenCalled();
    expect(intentStatuses).toEqual(["scanning"]);
  });

  test("keeps the durable intent recoverable when ambiguous-write cleanup fails", async () => {
    const writeError = new Error("object storage timed out");
    s3WriteMock.mockRejectedValue(writeError);
    s3DeleteMock.mockRejectedValue(new Error("object deletion timed out"));

    const attempted = await Result.tryPromise({
      try: async () => await createEntityVersionFromBuffer(baseInput),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error).toBe(writeError);
    }
    expect(s3DeleteMock).toHaveBeenCalledWith(
      "org_1/ws_1/file_1.docx",
      expect.any(AbortSignal),
    );
    expect(intentStatuses).toEqual(["scanning"]);
  });

  test("stores bytes and delegates the canonical locked transaction", async () => {
    writeFileVersionMock.mockImplementation(async (input) => {
      const result = {
        status: "ok" as const,
        entityVersionId: input.entityVersionId,
        fieldId: input.fieldId,
        filePropertyId: toSafeId<"property">("property_1"),
        versionNumber: 2,
      };
      await input.afterWrite(result);
      return result;
    });

    const result = await createEntityVersionFromBuffer(baseInput);

    expect(Result.isOk(result)).toBe(true);
    expect(s3WriteMock).toHaveBeenCalledTimes(1);
    expect(s3WriteMock).toHaveBeenCalledWith(
      "org_1/ws_1/file_1.docx",
      expect.any(Uint8Array),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      expect.any(AbortSignal),
    );
    expect(persistenceEvents).toEqual(["intent-reserved", "s3-written"]);
    expect(writeFileVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        entityId: "entity_1",
        fileId: "file_1",
        fileName: "filled.docx",
        sizeBytes: Buffer.byteLength("filled docx"),
        source: null,
      }),
    );
    expect(s3DeleteMock).not.toHaveBeenCalled();
    expect(processExtractionMock).toHaveBeenCalledWith("entity_1", {
      filePropertyId: "property_1",
    });
    expect(broadcastMock).toHaveBeenCalledWith("ws_1", {
      type: "invalidate-query",
      data: ["entities", "ws_1"],
    });
  });

  test("deletes the object when the target rejects under the lock", async () => {
    writeFileVersionMock.mockResolvedValue({ status: "entity-read-only" });

    const result = await createEntityVersionFromBuffer(baseInput);

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("entity-read-only");
    }
    expect(s3DeleteMock).toHaveBeenCalledWith(
      "org_1/ws_1/file_1.docx",
      expect.any(AbortSignal),
    );
    expect(processExtractionMock).not.toHaveBeenCalled();
  });

  test("deletes the object when the transaction callback fails before commit", async () => {
    writeFileVersionMock.mockRejectedValue(new Error("db unavailable"));

    const attempted = await Result.tryPromise({
      try: async () => await createEntityVersionFromBuffer(baseInput),
      catch: (cause) => cause,
    });
    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error).toBeInstanceOf(Error);
      if (attempted.error instanceof Error) {
        expect(attempted.error.message).toBe("db unavailable");
      }
    }
    expect(s3DeleteMock).toHaveBeenCalledWith(
      "org_1/ws_1/file_1.docx",
      expect.any(AbortSignal),
    );
  });

  test("preserves the object when the commit acknowledgement is ambiguous", async () => {
    writeFileVersionMock.mockImplementation(async (input) => {
      const result = {
        status: "ok" as const,
        entityVersionId: input.entityVersionId,
        fieldId: input.fieldId,
        filePropertyId: toSafeId<"property">("property_1"),
        versionNumber: 2,
      };
      await input.afterWrite(result);
      return result;
    });
    const commitError = new Error("connection lost after commit");
    let safeDbCall = 0;
    const ambiguousSafeDb = asTestRaw<SafeDb>(
      async <T>(run: (tx: Transaction) => Promise<T>) => {
        safeDbCall += 1;
        const value = await run(createTestTransaction());
        return safeDbCall === 2 ? Result.err(commitError) : Result.ok(value);
      },
    );

    const attempted = await Result.tryPromise({
      try: async () =>
        await createEntityVersionFromBuffer({
          ...baseInput,
          safeDb: ambiguousSafeDb,
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error).toBe(commitError);
    }
    expect(s3DeleteMock).not.toHaveBeenCalled();
    expect(processExtractionMock).not.toHaveBeenCalled();
  });

  test("rolls back persistence when the in-transaction callback fails", async () => {
    writeFileVersionMock.mockImplementation(async (input) => {
      const result = {
        status: "ok" as const,
        entityVersionId: input.entityVersionId,
        fieldId: input.fieldId,
        filePropertyId: toSafeId<"property">("property_1"),
        versionNumber: 2,
      };
      await input.afterWrite(result);
      return result;
    });

    const attempted = await Result.tryPromise({
      try: async () =>
        await createEntityVersionFromBuffer({
          ...baseInput,
          afterWrite: async () => {
            throw new Error("audit failed");
          },
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted) && attempted.error instanceof Error) {
      expect(attempted.error.message).toBe("audit failed");
    }
    expect(s3DeleteMock).toHaveBeenCalledWith(
      "org_1/ws_1/file_1.docx",
      expect.any(AbortSignal),
    );
    expect(processExtractionMock).not.toHaveBeenCalled();
  });
});
