import { panic, Result, TaggedError } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  entities,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { uploadEntityHandler } from "@/api/handlers/entities/upload";
import { UPLOAD_ENTITY_ORIGIN } from "@/api/handlers/entities/upload-origin";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { reconcileBufferObjectCleanupIntents } from "@/api/lib/buffer-intent-reconciliation";
import { deleteOrganizationFilesWithSignal } from "@/api/lib/files/delete-organization-file";
import type { writeOrganizationFile } from "@/api/lib/files/organization-file-usage";
import { configureS3ForTesting } from "@/api/lib/s3";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

class UploadTransactionRefused extends TaggedError("UploadTransactionRefused")<{
  message: string;
}> {}

let testDb: TestDatabase;
let ids: TestIds;
const originalFlag = env.FEATURE_FILE_USAGE_LIMITS;
const originalWorkerFlag =
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
const policyId = createSafeId<"usagePolicy">();
const entitlementId = createSafeId<"usageEntitlement">();
const assignmentId = createSafeId<"usageSeatAssignment">();
const acceptedAudit: AuditRecorder = async () => await Promise.resolve();

const memberSafeDb = () =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));
const fileUsageDb = () =>
  asTestRaw<NonNullable<Parameters<typeof writeOrganizationFile>[0]["db"]>>(
    testDb,
  );

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  await testDb.insert(usagePolicies).values({
    id: policyId,
    policyKey: `upload-cleanup-${policyId}`.slice(0, 64),
    displayName: "Upload cleanup fixture",
    monthlyUsageUnits: 0,
    storageBytesPerAssignment: 1_000_000n,
  });
  await testDb.insert(usageEntitlements).values({
    id: entitlementId,
    organizationId: ids.orgA,
    usagePolicyId: policyId,
    status: "active",
    seats: 1,
    currentPeriodStart: new Date("2020-01-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2100-01-01T00:00:00.000Z"),
    source: "manual",
  });
  await testDb.insert(usageSeatAssignments).values({
    id: assignmentId,
    organizationId: ids.orgA,
    userId: ids.userA1,
  });
});

afterAll(async () => {
  env.FEATURE_FILE_USAGE_LIMITS = originalFlag;
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = originalWorkerFlag;
  await releaseTestDb();
});

const upload = async (recordAuditEvent = acceptedAudit) =>
  await Result.gen(() =>
    uploadEntityHandler({
      safeDb: memberSafeDb(),
      fileUsageDb: fileUsageDb(),
      processEntity: async () => await Promise.resolve(),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      recordAuditEvent,
      body: {
        file: new File(["Upload cleanup regression bytes"], "cleanup.txt", {
          type: "text/plain",
        }),
        name: "cleanup.txt",
        propertyId: ids.filePropertyA1,
        origin: UPLOAD_ENTITY_ORIGIN.GENERATED_DOCUMENT,
      },
    }),
  );

const intentRows = async () =>
  await testDb
    .select()
    .from(bufferObjectCleanupIntents)
    .where(eq(bufferObjectCleanupIntents.organizationId, ids.orgA));

const reconcile = async () =>
  await reconcileBufferObjectCleanupIntents({
    safeDb: memberSafeDb(),
    limit: 25,
    deleteObject: async (key, signal) =>
      await deleteOrganizationFilesWithSignal([key], signal, {
        fileUsageDb: fileUsageDb(),
      }),
  });

const makeCleanupDue = async () => {
  await testDb
    .update(bufferObjectCleanupIntents)
    .set({ nextAttemptAt: new Date("2000-01-01T00:00:00.000Z") })
    .where(eq(bufferObjectCleanupIntents.organizationId, ids.orgA));
};

const entityCount = async () =>
  await testDb.$count(entities, eq(entities.workspaceId, ids.wsA1));

const putRequests = (store: FakeS3) =>
  store.requests.filter(({ method }) => method === "PUT");

const configureStore = (flag: boolean) => {
  env.FEATURE_FILE_USAGE_LIMITS = flag;
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = flag;
  const store = startFakeS3();
  configureS3ForTesting({ endpoint: store.endpoint, writeTimeoutMs: 1000 });
  return store;
};

const defineFlagTests = (flag: boolean) => {
  describe(`multipart cleanup with file usage limits ${String(flag)}`, () => {
    test("reconciliation deletes a first PUT that finishes after retry success and transaction refusal", async () => {
      const store = configureStore(flag);
      const hold = store.holdNext({ method: "PUT", keyIncludes: ids.orgA });
      const refusal = new UploadTransactionRefused({
        message: "Entity transaction refused",
      });
      let auditCalls = 0;
      const refuseAudit: AuditRecorder = async () => {
        auditCalls += 1;
        throw refusal;
      };
      const before = await entityCount();
      const pending = upload(refuseAudit);
      try {
        await hold.reached;
        const result = await pending;
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.cause).toBe(refusal);
        }
        expect(auditCalls).toBe(1);
        expect(await entityCount()).toBe(before);
        const puts = putRequests(store);
        expect(puts.length).toBeGreaterThanOrEqual(2);
        const sourceKey = puts.at(0)?.key ?? panic("Expected a PUT request");
        expect(new Set(puts.map(({ key }) => key)).size).toBe(1);
        const intent = (await intentRows()).at(0);
        expect(intent).toMatchObject({
          objectKey: sourceKey,
          status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
        });
        // A confirmed DELETE of the retry object cannot retire ownership of
        // the first PUT, which the store has accepted but has not applied.
        expect(await reconcile()).toBe(1);
        expect(await intentRows()).toHaveLength(1);
        expect(store.objects.has(`${envBase.S3_BUCKET}/${sourceKey}`)).toBe(
          false,
        );
        hold.release();
        await hold.completed;
        expect(store.objects.has(`${envBase.S3_BUCKET}/${sourceKey}`)).toBe(
          true,
        );
        await makeCleanupDue();
        expect(await reconcile()).toBe(1);
        expect(store.objects.has(`${envBase.S3_BUCKET}/${sourceKey}`)).toBe(
          false,
        );
        expect(await intentRows()).toHaveLength(1);
      } finally {
        hold.release();
        await hold.completed;
        store.stop();
        await testDb
          .delete(bufferObjectCleanupIntents)
          .where(eq(bufferObjectCleanupIntents.organizationId, ids.orgA));
      }
    });

    test("exhausting every PUT attempt preserves durable recovery ownership", async () => {
      const store = configureStore(flag);
      store.failNext({
        method: "PUT",
        code: "InternalError",
        status: 500,
        times: 20,
      });
      const before = await entityCount();
      try {
        const result = await upload();
        expect(result.isErr()).toBe(true);
        expect(await entityCount()).toBe(before);
        const puts = putRequests(store);
        expect(puts.length).toBeGreaterThanOrEqual(2);
        const sourceKey = puts.at(0)?.key ?? panic("Expected a PUT request");
        expect(await intentRows()).toMatchObject([
          {
            objectKey: sourceKey,
            status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
          },
        ]);
        expect(await reconcile()).toBe(1);
        expect(await intentRows()).toHaveLength(1);
        expect(store.objects.size).toBe(0);
      } finally {
        store.stop();
        await testDb
          .delete(bufferObjectCleanupIntents)
          .where(eq(bufferObjectCleanupIntents.organizationId, ids.orgA));
      }
    });

    test("a confirmed PUT refusal retires cleanup ownership after deleting the object", async () => {
      const store = configureStore(flag);
      const refusal = new UploadTransactionRefused({
        message: "Entity transaction refused",
      });
      const before = await entityCount();
      try {
        const result = await upload(async () => {
          throw refusal;
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.cause).toBe(refusal);
        }
        expect(await entityCount()).toBe(before);
        expect(putRequests(store)).toHaveLength(1);
        expect(await intentRows()).toHaveLength(0);
        expect(store.objects.size).toBe(0);
      } finally {
        store.stop();
      }
    });

    test("a refused DELETE keeps confirmed write ownership for reconciliation", async () => {
      const store = configureStore(flag);
      store.failNext({ method: "DELETE", code: "AccessDenied", status: 403 });
      const refusal = new UploadTransactionRefused({
        message: "Entity transaction refused",
      });
      try {
        const result = await upload(async () => {
          throw refusal;
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.cause).toBe(refusal);
        }
        expect(await intentRows()).toMatchObject([
          { status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED },
        ]);
        expect(store.objects.size).toBe(1);
        await makeCleanupDue();
        expect(await reconcile()).toBe(1);
        expect(await intentRows()).toHaveLength(0);
        expect(store.objects.size).toBe(0);
      } finally {
        store.stop();
        await testDb
          .delete(bufferObjectCleanupIntents)
          .where(eq(bufferObjectCleanupIntents.organizationId, ids.orgA));
      }
    });

    test("a committed entity retires its cleanup intent and keeps its object", async () => {
      const store = configureStore(flag);
      const before = await entityCount();
      let auditCalls = 0;
      const audited: AuditRecorder = async () => {
        auditCalls += 1;
        await Promise.resolve();
      };
      try {
        const result = await upload(audited);
        expect(result.isOk()).toBe(true);
        expect(auditCalls).toBe(1);
        expect(await entityCount()).toBe(before + 1);
        expect(await intentRows()).toHaveLength(0);
        const puts = putRequests(store);
        expect(puts).toHaveLength(1);
        const sourceKey = puts.at(0)?.key ?? panic("Expected a PUT request");
        expect(store.objects.has(`${envBase.S3_BUCKET}/${sourceKey}`)).toBe(
          true,
        );
        expect(await reconcile()).toBe(0);
        expect(
          store.requests.filter(({ method }) => method === "DELETE"),
        ).toHaveLength(0);
      } finally {
        store.stop();
      }
    });
  });
};

for (const flag of [false, true]) {
  defineFlagTests(flag);
}
