import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { rootDb, Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  extractedContent,
  fields,
  organizationSettings,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { requestAutomaticDocumentOcr } from "@/api/lib/document-processing-automatic-request";
import {
  DOCUMENT_OCR_PROCESSOR_VERSION,
  DOCUMENT_PROCESSING_MAX_ATTEMPTS,
} from "@/api/lib/document-processing-contract";
import { persistManualOcrRun } from "@/api/lib/document-processing-request";
import { claimDocumentProcessingAttempt } from "@/api/lib/document-processing-retry";
import type { restoreManualOcrRunAfterProjectionLoss as RestoreManualOcrRunAfterProjectionLoss } from "@/api/lib/search/document-processing-manual-ocr-restore";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const SOURCE_FILE_ID = Bun.randomUUIDv7();
const SOURCE_SHA256_HEX = "a".repeat(64);
const UNRELATED_FILE_ID = Bun.randomUUIDv7();
const UNRELATED_SHA256_HEX = "b".repeat(64);

let testDb: TestDatabase;
let ids: TestIds;
let restoreManualOcrRunAfterProjectionLoss: typeof RestoreManualOcrRunAfterProjectionLoss;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  ({ restoreManualOcrRunAfterProjectionLoss } =
    await import("@/api/lib/search/document-processing-manual-ocr-restore"));
}, 120_000);

beforeEach(async () => {
  await testDb
    .update(organizationSettings)
    .set({ documentProcessingMode: "searchable-text" })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  await testDb
    .delete(extractedContent)
    .where(eq(extractedContent.organizationId, ids.orgA));
  await testDb
    .delete(documentProcessingRuns)
    .where(eq(documentProcessingRuns.organizationId, ids.orgA));
  await testDb
    .update(fields)
    .set({
      content: {
        encrypted: false,
        fileName: "scan.pdf",
        id: SOURCE_FILE_ID,
        mimeType: PDF_MIME_TYPE,
        pdfFileId: null,
        sha256Hex: SOURCE_SHA256_HEX,
        sizeBytes: 128,
        type: "file",
        version: 1,
      },
    })
    .where(eq(fields.id, ids.fieldA1));
});

afterAll(async () => {
  await releaseTestDb();
});

const insertRun = async ({
  attemptCount = 2,
  requestSource = "manual",
  entityId = ids.entityA1,
  entityVersionId = ids.entityVersionA1,
  errorCode = "prior_error",
  fieldId = ids.fieldA1,
  runId = toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  sourceFileId = SOURCE_FILE_ID,
  sourceSha256Hex = SOURCE_SHA256_HEX,
  status = "succeeded",
  workspaceId = ids.wsA1,
}: {
  attemptCount?: number;
  requestSource?: (typeof documentProcessingRuns.$inferSelect)["requestSource"];
  entityId?: SafeId<"entity">;
  entityVersionId?: SafeId<"entityVersion">;
  errorCode?: string | null;
  fieldId?: SafeId<"field">;
  runId?: SafeId<"documentProcessingRun">;
  sourceFileId?: string;
  sourceSha256Hex?: string;
  status?: (typeof documentProcessingRuns.$inferSelect)["status"];
  workspaceId?: SafeId<"workspace">;
} = {}) => {
  const lifecycleAt = new Date("2026-08-08T12:00:00.000Z");
  await testDb.insert(documentProcessingRuns).values({
    attemptCount,
    claimedAt: lifecycleAt,
    claimedBy: "worker_1",
    entityId,
    entityVersionId,
    errorAt: lifecycleAt,
    errorCode,
    fieldId,
    finishedAt: lifecycleAt,
    id: runId,
    kind: "ocr",
    nextAttemptAt: lifecycleAt,
    organizationId: ids.orgA,
    processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
    progressCompleted: 3,
    progressTotal: 3,
    requestSource,
    requestedBy: ids.userA1,
    sourceFileId,
    sourceSha256Hex,
    startedAt: lifecycleAt,
    status,
    workspaceId,
  });
  return runId;
};

const restore = async ({
  sourceFileId = SOURCE_FILE_ID,
  sourceSha256Hex = SOURCE_SHA256_HEX,
} = {}) =>
  await restoreManualOcrRunAfterProjectionLoss({
    db: asTestRaw<
      NonNullable<
        Parameters<typeof restoreManualOcrRunAfterProjectionLoss>[0]["db"]
      >
    >(testDb),
    entityId: ids.entityA1,
    entityVersionId: ids.entityVersionA1,
    fieldId: ids.fieldA1,
    organizationId: ids.orgA,
    sourceFileId,
    sourceSha256Hex,
    workspaceId: ids.wsA1,
  });

const readRun = async (runId: SafeId<"documentProcessingRun">) =>
  (
    await testDb
      .select({
        claimedAt: documentProcessingRuns.claimedAt,
        claimedBy: documentProcessingRuns.claimedBy,
        errorAt: documentProcessingRuns.errorAt,
        errorCode: documentProcessingRuns.errorCode,
        finishedAt: documentProcessingRuns.finishedAt,
        nextAttemptAt: documentProcessingRuns.nextAttemptAt,
        progressCompleted: documentProcessingRuns.progressCompleted,
        progressTotal: documentProcessingRuns.progressTotal,
        startedAt: documentProcessingRuns.startedAt,
        status: documentProcessingRuns.status,
      })
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, runId))
      .limit(1)
  ).at(0);

const insertProjection = async ({
  ocrRunId,
}: {
  ocrRunId: SafeId<"documentProcessingRun"> | null;
}) => {
  await testDb.insert(extractedContent).values({
    charCount: 0,
    ciphertext: Buffer.from("ciphertext"),
    entityId: ids.entityA1,
    extractedAt: new Date(),
    iv: Buffer.from("iv"),
    ocrPayloadCiphertext: ocrRunId === null ? null : Buffer.from("ocr-payload"),
    ocrPayloadIv: ocrRunId === null ? null : Buffer.from("ocr-iv"),
    ocrProcessorVersion:
      ocrRunId === null ? null : DOCUMENT_OCR_PROCESSOR_VERSION,
    ocrRunId,
    organizationId: ids.orgA,
    sourceEntityVersionId: ids.entityVersionA1,
    sourceFieldId: ids.fieldA1,
    sourceFileId: SOURCE_FILE_ID,
    sourceSha256Hex: SOURCE_SHA256_HEX,
    workspaceId: ids.wsA1,
  });
};

describe("restoreManualOcrRunAfterProjectionLoss", () => {
  test("requeues a matching succeeded manual run when its projection is missing", async () => {
    const runId = await insertRun();
    const unrelatedRunId = await insertRun({
      sourceFileId: UNRELATED_FILE_ID,
      sourceSha256Hex: UNRELATED_SHA256_HEX,
    });

    await restore();

    expect(await readRun(runId)).toEqual({
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
    });
    expect((await readRun(unrelatedRunId))?.status).toBe("succeeded");
  });

  test("requeues when a same-source native projection replaced manual OCR", async () => {
    const runId = await insertRun();
    await insertProjection({ ocrRunId: null });

    await restore();

    expect((await readRun(runId))?.status).toBe("queued");
  });

  test("leaves a succeeded run unchanged while it owns the exact projection", async () => {
    const runId = await insertRun();
    await insertProjection({ ocrRunId: runId });

    await restore();

    const restored = await readRun(runId);
    expect(restored?.status).toBe("succeeded");
    expect(restored?.finishedAt).not.toBeNull();
    expect(restored?.progressCompleted).toBe(3);
  });

  test("requeues a search-index failure after its OCR projection is replaced", async () => {
    const runId = await insertRun({
      errorCode: "search_index_failed",
      status: "failed",
    });
    await insertProjection({ ocrRunId: null });

    await restore();

    const restored = await readRun(runId);
    expect(restored?.status).toBe("queued");
    expect(restored?.errorCode).toBeNull();
  });

  test("requeues a source-superseded run after the source becomes current again", async () => {
    const runId = await insertRun({
      errorCode: "source_superseded",
      status: "cancelled",
    });

    await restore();

    expect((await readRun(runId))?.status).toBe("queued");
  });

  test("does not requeue a run after its file source stops being current", async () => {
    const runId = await insertRun({
      sourceFileId: UNRELATED_FILE_ID,
      sourceSha256Hex: UNRELATED_SHA256_HEX,
    });

    await restore({
      sourceFileId: UNRELATED_FILE_ID,
      sourceSha256Hex: UNRELATED_SHA256_HEX,
    });

    expect((await readRun(runId))?.status).toBe("succeeded");
  });
});

// Exercise the persisted queue state through the worker's actual claim fence.
const expectClaimable = async (runId: SafeId<"documentProcessingRun">) => {
  const queued = (
    await testDb
      .select()
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, runId))
  ).at(0);
  expect(queued?.status).toBe("queued");
  expect(queued?.attemptCount).toBeLessThan(DOCUMENT_PROCESSING_MAX_ATTEMPTS);
  expect(queued?.nextAttemptAt).toBeNull();
  const claimed = await testDb.transaction(
    async (tx) =>
      await claimDocumentProcessingAttempt({
        database: asTestRaw<Transaction>(tx),
        runId,
        claimToken: "fresh-budget-worker",
        now: new Date(),
      }),
  );
  expect(claimed?.status).toBe("running");
  expect(queued).toBeDefined();
  if (queued) {
    expect(claimed?.attemptCount).toBe(queued.attemptCount + 1);
  }
};

test.each(
  (["upload", "repair", "manual"] as const).flatMap((requestSource) =>
    (
      [
        "queued",
        "failed",
        "succeeded",
        "cancelled",
        ...(requestSource === "manual" ? [] : (["running"] as const)),
      ] as const
    ).map((status) => ({ requestSource, status })),
  ),
)(
  "manual retry of capped $requestSource $status work starts a claimable fresh budget",
  async ({ requestSource, status }) => {
    const runId = await insertRun({
      attemptCount: DOCUMENT_PROCESSING_MAX_ATTEMPTS,
      requestSource,
      status,
      errorCode: "source_superseded",
    });
    // A running automatic run must replace a different source's projection.
    await testDb.insert(extractedContent).values({
      charCount: 0,
      ciphertext: Buffer.from("ciphertext"),
      iv: Buffer.from("iv"),
      extractedAt: new Date(),
      entityId: ids.entityA1,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      sourceFileId: UNRELATED_FILE_ID,
      sourceSha256Hex: UNRELATED_SHA256_HEX,
    });
    const request = async () =>
      await persistManualOcrRun({
        db: asTestRaw<Pick<typeof rootDb, "transaction">>(testDb),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        source: {
          entityId: ids.entityA1,
          entityVersionId: ids.entityVersionA1,
          fieldId: ids.fieldA1,
          sourceFileId: SOURCE_FILE_ID,
          sourceSha256Hex: SOURCE_SHA256_HEX,
        },
        recordAuditEvent: async () => undefined,
      });
    const result = await request();
    expect(result?.id).toBe(runId);
    const queued = (
      await testDb
        .select()
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, runId))
    ).at(0);
    expect(queued?.attemptCount).toBe(0);
    expect(queued?.requestSource).toBe("manual");
    await expectClaimable(runId);
    // Repeated requests reuse the manual worker and cannot renew its budget.
    expect((await request())?.status).toBe("running");
    const reused = (
      await testDb
        .select()
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, runId))
    ).at(0);
    expect(reused?.attemptCount).toBe(1);
    expect(reused?.claimedBy).toBe("fresh-budget-worker");
  },
);

test.each(["succeeded", "cancelled"] as const)(
  "projection restore of capped %s manual work remains claimable",
  async (status) => {
    const runId = await insertRun({
      attemptCount: DOCUMENT_PROCESSING_MAX_ATTEMPTS,
      status,
      errorCode: "source_superseded",
    });
    await restore();
    await expectClaimable(runId);
  },
);

test.each(
  (["upload", "repair"] as const).flatMap((requestSource) =>
    (["succeeded", "failed"] as const).map((status) => ({
      requestSource,
      status,
    })),
  ),
)(
  "automatic $requestSource request at the cap handles $status work without retrying exhausted failures",
  async ({ requestSource, status }) => {
    const runId = await insertRun({
      attemptCount: DOCUMENT_PROCESSING_MAX_ATTEMPTS,
      requestSource,
      status,
    });
    await requestAutomaticDocumentOcr({
      db: asTestRaw<Pick<typeof rootDb, "transaction">>(testDb),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      entityVersionId: ids.entityVersionA1,
      fieldId: ids.fieldA1,
      sourceFileId: SOURCE_FILE_ID,
      sourceSha256Hex: SOURCE_SHA256_HEX,
      requestSource,
    });
    if (status === "succeeded") {
      await expectClaimable(runId);
      return;
    }
    const failed = (
      await testDb
        .select()
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, runId))
    ).at(0);
    expect(failed?.status).toBe("failed");
    expect(failed?.attemptCount).toBe(DOCUMENT_PROCESSING_MAX_ATTEMPTS);
  },
);
