import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { databaseRelations } from "@/api/db/database-relations";
import type { rootDb } from "@/api/db/root";
import { documentProcessingRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createDocumentProcessingReconciliationPhases,
  createRepairPassMemo,
  NATIVE_CONTENT_SEARCH_BOUND_MS,
} from "@/api/lib/document-processing-queue";
import type { DocumentProcessingReconciliationDependencies } from "@/api/lib/document-processing-queue";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { createDispatchNativeExtractionTask } from "@/api/lib/scheduler/tasks/document-processing-native-extraction";
import { createDispatchDocumentOcrTask } from "@/api/lib/scheduler/tasks/document-processing-ocr";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const OCR_VISIBILITY_DELAY_MS = 5 * 60 * 1000;
const ids = createTestIds();
const runIds = {
  nativeFirst: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  nativeRetry: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  ocrFirst: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  ocrRetry: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle<typeof databaseRelations>>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: databaseRelations });
  await setupRlsTestData(asTestRaw<TestDatabase>(db), ids);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(documentProcessingRuns).where(sql`true`);
  const due = new Date(Date.now() - 60_000);
  await db.insert(documentProcessingRuns).values(
    Object.entries(runIds).map(([label, id], index) => {
      const native = label.startsWith("native");
      const retry = label.endsWith("Retry");
      return {
        entityId: ids.entityA1,
        entityVersionId: ids.entityVersionA1,
        fieldId: ids.fileFieldA1,
        id,
        kind: native ? ("native-extraction" as const) : ("ocr" as const),
        nextAttemptAt: retry ? due : null,
        organizationId: ids.orgA,
        processorVersion: index + 1,
        requestedBy: null,
        requestSource: "upload" as const,
        sourceFileId: ids.fileObjectA1,
        sourceSha256Hex: "a".repeat(64),
        workspaceId: ids.wsA1,
      };
    }),
  );
});

const recordedIds = () => {
  const enqueued: SafeId<"documentProcessingRun">[] = [];
  return {
    enqueued,
    enqueue: async (runId: SafeId<"documentProcessingRun">) => {
      enqueued.push(runId);
    },
  };
};

const reconciliationDependencies = (
  enqueueDocumentProcessingRun: DocumentProcessingReconciliationDependencies["enqueueDocumentProcessingRun"],
) =>
  ({
    broadcastWorkspaceResourceUpdated: () => undefined,
    database: asTestRaw<typeof rootDb>(db),
    enqueueDocumentDeadlineScout: async () => undefined,
    enqueueDocumentProcessingRun,
    indexEntity: async () => undefined,
    now: () => Date.now(),
    readRepairScanCursor: async () => null,
    readyRepairCursor: async () => undefined,
    repairPassMemo: createRepairPassMemo(),
    writeRepairScanCursor: async () => true,
  }) satisfies DocumentProcessingReconciliationDependencies;

const schedulerContext = (): SchedulerTaskContext =>
  asTestRaw<SchedulerTaskContext>({
    db: asTestRaw<typeof rootDb>(db),
    dueAt: DueSlot.of({ nextRunAt: new Date() }),
    logger: { info: () => undefined },
    scheduleContinuation: () => undefined,
    signal: new AbortController().signal,
  });

const readDeliveryTimes = async () =>
  await db
    .select({
      id: documentProcessingRuns.id,
      at: documentProcessingRuns.nextDeliveryAt,
    })
    .from(documentProcessingRuns)
    .orderBy(asc(documentProcessingRuns.id));

test("reconciliation dispatches only scheduled retries", async () => {
  const recording = recordedIds();
  const delivery = createDocumentProcessingReconciliationPhases(
    reconciliationDependencies(recording.enqueue),
  ).find(({ name }) => name === "delivery");
  if (!delivery) {
    throw new TypeError("Expected the reconciliation delivery phase");
  }

  await delivery.run();

  expect(recording.enqueued.toSorted()).toEqual(
    [runIds.nativeRetry, runIds.ocrRetry].toSorted(),
  );
});

test("reconciliation leaves future retries queued until their due time", async () => {
  const nextAttemptAt = new Date(Date.now() + 60_000);
  await db
    .update(documentProcessingRuns)
    .set({ nextAttemptAt, nextDeliveryAt: null })
    .where(eq(documentProcessingRuns.id, runIds.nativeRetry));
  const recording = recordedIds();
  const delivery = createDocumentProcessingReconciliationPhases(
    reconciliationDependencies(recording.enqueue),
  ).find(({ name }) => name === "delivery");
  if (!delivery) {
    throw new TypeError("Expected the reconciliation delivery phase");
  }

  await delivery.run();

  expect(recording.enqueued).toEqual([runIds.ocrRetry]);
  const future = (await readDeliveryTimes()).find(
    ({ id }) => id === runIds.nativeRetry,
  );
  expect(future?.at).toBeNull();
});

test("the OCR scheduler dispatches only OCR runs", async () => {
  const recording = recordedIds();
  const before = Date.now();
  await createDispatchDocumentOcrTask(recording.enqueue)(schedulerContext());

  expect(recording.enqueued.toSorted()).toEqual(
    [runIds.ocrFirst, runIds.ocrRetry].toSorted(),
  );
  const ocr = (await readDeliveryTimes()).find(
    ({ id }) => id === runIds.ocrFirst,
  );
  expect(ocr?.at?.getTime()).toBeGreaterThanOrEqual(
    before + OCR_VISIBILITY_DELAY_MS,
  );
});

test("the native scheduler dispatches only native runs", async () => {
  const recording = recordedIds();
  const before = Date.now();
  await createDispatchNativeExtractionTask(recording.enqueue)(
    schedulerContext(),
  );

  expect(recording.enqueued.toSorted()).toEqual(
    [runIds.nativeFirst, runIds.nativeRetry].toSorted(),
  );
  const native = (await readDeliveryTimes()).find(
    ({ id }) => id === runIds.nativeFirst,
  );
  expect(native?.at?.getTime()).toBeGreaterThanOrEqual(
    before + NATIVE_CONTENT_SEARCH_BOUND_MS,
  );
  expect(native?.at?.getTime()).toBeLessThan(before + OCR_VISIBILITY_DELAY_MS);
});
