import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { REALTIME_EVENT_TYPE, RESOURCE_TYPE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { bufferObjectCleanupIntents, workspaces } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3, FakeS3Method } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const writeFileVersionMock = mock();
const processExtractionMock = mock();
const requestNativeExtractionRunMock = mock();
const pdfDerivativeMock = mock();
const thumbnailDerivativeMock = mock();
const diffStatsMock = mock();
const broadcastMock = mock();
let persistenceEvents: string[] = [];
let intentStatuses: string[] = [];
/**
 * How many objects the store had received when the durable intent row was
 * inserted. The intent is what reclaims an orphaned object, so it must be
 * durable before anything is published.
 */
let putsAtIntentReservation: number[] = [];

const realSse = await import("@/api/lib/sse");

void mock.module("@/api/lib/entity-versions/write-file-version", () => ({
  writeFileVersion: writeFileVersionMock,
}));
const realFileObjectIds = await import("@/api/lib/files/file-object-ids");
void mock.module("@/api/lib/files/file-object-ids", () => ({
  ...realFileObjectIds,
  allocateFileObject: () => "file_1",
}));
void mock.module("@/api/lib/files/utils", () => ({
  createFileKey: () => "org_1/ws_1/file_1.docx",
}));
void mock.module("@/api/lib/search/process-extraction", () => ({
  processExtraction: processExtractionMock,
  requestNativeExtractionRun: requestNativeExtractionRunMock,
}));
const realFileDerivativeQueue = await import("@/api/lib/file-derivative-queue");
void mock.module("@/api/lib/file-derivative-queue", () => ({
  ...realFileDerivativeQueue,
  enqueuePdfDerivativeOrMarkFailed: pdfDerivativeMock,
  enqueueImageThumbnailOrMarkFailed: thumbnailDerivativeMock,
}));
void mock.module("@/api/lib/entity-versions/compute-version-diff", () => ({
  computeVersionDiffStats: diffStatsMock,
}));
void mock.module("@/api/lib/root-scoped-db", () => ({
  createRootScopedDb: () => mock(),
}));
void mock.module("@/api/lib/sse", () => ({
  ...realSse,
  broadcast: broadcastMock,
  broadcastToOrganization: mock(),
}));
const realCapture = await import("@/api/lib/analytics/capture");
void mock.module("@/api/lib/analytics/capture", () => ({
  ...realCapture,
  captureError: mock(),
  captureRequestError: mock(),
}));

const { createEntityVersionFromBuffer } =
  await import("@/api/lib/entity-versions/create-entity-version-from-buffer");

/** The key `createFileKey` (mocked above) hands the writer for this input. */
const OBJECT_KEY = "org_1/ws_1/file_1.docx";
const STORED_OBJECT_ID = `${envBase.S3_BUCKET}/${OBJECT_KEY}`;
const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let fake: FakeS3;

const requestedKeys = (method: FakeS3Method): string[] =>
  fake.requests
    .filter((request) => request.method === method)
    .map((request) => request.key);

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
        putsAtIntentReservation.push(requestedKeys("PUT").length);
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
  mimeType: DOCX_MIME_TYPE,
  source: null,
  writePolicy: { type: "replace-current-file" as const },
};

describe("createEntityVersionFromBuffer", () => {
  beforeEach(() => {
    fake = startFakeS3();
    for (const fn of [
      writeFileVersionMock,
      processExtractionMock,
      requestNativeExtractionRunMock,
      pdfDerivativeMock,
      thumbnailDerivativeMock,
      diffStatsMock,
      broadcastMock,
    ]) {
      fn.mockReset();
    }
    processExtractionMock.mockResolvedValue(undefined);
    requestNativeExtractionRunMock.mockResolvedValue(null);
    pdfDerivativeMock.mockResolvedValue(undefined);
    thumbnailDerivativeMock.mockResolvedValue(undefined);
    diffStatsMock.mockResolvedValue(undefined);
    persistenceEvents = [];
    intentStatuses = [];
    putsAtIntentReservation = [];
  });

  afterEach(() => {
    fake.stop();
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
    // Nothing reached object storage: the ceiling is checked before the
    // durable intent and before any request.
    expect(fake.requests).toEqual([]);
    expect(writeFileVersionMock).not.toHaveBeenCalled();
  });

  test("keeps recovery after deleting an ambiguous initial write", async () => {
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });

    const attempted = await Result.tryPromise({
      try: async () => await createEntityVersionFromBuffer(baseInput),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      // The store's own rejection reaches the caller: it is what tells a
      // retry apart from a refusal.
      expect(attempted.error instanceof Error ? attempted.error.name : "").toBe(
        "AccessDenied",
      );
    }
    // A publication the failure may have raced is deleted, so no orphan
    // survives under the reserved key.
    expect(requestedKeys("DELETE")).toEqual([OBJECT_KEY]);
    expect(fake.objects.has(STORED_OBJECT_ID)).toBe(false);
    expect(writeFileVersionMock).not.toHaveBeenCalled();
    expect(intentStatuses).toEqual(["scanning"]);
  });

  test("keeps the durable intent recoverable when ambiguous-write cleanup fails", async () => {
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });
    fake.failNext({ method: "DELETE", code: "AccessDenied", status: 403 });

    const attempted = await Result.tryPromise({
      try: async () => await createEntityVersionFromBuffer(baseInput),
      catch: (cause) => cause,
    });

    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      // The write failure, not the cleanup's: the caller is told why the
      // version did not happen.
      expect(attempted.error instanceof Error ? attempted.error.name : "").toBe(
        "AccessDenied",
      );
    }
    expect(requestedKeys("DELETE")).toEqual([OBJECT_KEY]);
    // Cleanup was refused, so the intent stays claimable by the sweeper
    // instead of being abandoned with an object possibly still out there.
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
    // The bytes the caller handed over are what the reserved key now holds,
    // under the document's own media type.
    expect(requestedKeys("PUT")).toEqual([OBJECT_KEY]);
    const stored = fake.objects.get(STORED_OBJECT_ID);
    expect(new TextDecoder().decode(stored?.bytes)).toBe("filled docx");
    expect(stored?.contentType).toBe(DOCX_MIME_TYPE);
    // Ordering: the intent that can reclaim the object is durable before the
    // object exists.
    expect(persistenceEvents).toEqual(["intent-reserved"]);
    expect(putsAtIntentReservation).toEqual([0]);
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
    expect(requestedKeys("DELETE")).toEqual([]);
    // The durable request is written inside the version transaction, pinned to
    // the same file property the post-commit acceleration resolves.
    expect(requestNativeExtractionRunMock).toHaveBeenCalledWith({
      entityId: "entity_1",
      filePropertyId: "property_1",
      tx: expect.anything(),
    });
    expect(processExtractionMock).toHaveBeenCalledWith("entity_1", {
      filePropertyId: "property_1",
    });
    expect(broadcastMock).toHaveBeenCalledWith("ws_1", {
      type: REALTIME_EVENT_TYPE.RESOURCE_UPDATED,
      resource: { type: RESOURCE_TYPE.ENTITY, id: "entity_1" },
    });
  });

  test("deletes the object when the target rejects under the lock", async () => {
    writeFileVersionMock.mockResolvedValue({ status: "entity-read-only" });

    const result = await createEntityVersionFromBuffer(baseInput);

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("entity-read-only");
    }
    // The rejected version leaves no object behind.
    expect(requestedKeys("DELETE")).toEqual([OBJECT_KEY]);
    expect(fake.objects.has(STORED_OBJECT_ID)).toBe(false);
    expect(requestNativeExtractionRunMock).not.toHaveBeenCalled();
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
    expect(requestedKeys("DELETE")).toEqual([OBJECT_KEY]);
    expect(fake.objects.has(STORED_OBJECT_ID)).toBe(false);
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
    // The commit may be durable, so the object a committed row would point at
    // survives untouched.
    expect(requestedKeys("DELETE")).toEqual([]);
    expect(fake.objects.has(STORED_OBJECT_ID)).toBe(true);
    // The extraction request rode along with the version write, so an
    // acknowledgement lost after that commit still leaves a queued run.
    expect(requestNativeExtractionRunMock).toHaveBeenCalledTimes(1);
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
    expect(requestedKeys("DELETE")).toEqual([OBJECT_KEY]);
    expect(fake.objects.has(STORED_OBJECT_ID)).toBe(false);
    expect(processExtractionMock).not.toHaveBeenCalled();
  });
});
