import { panic, Result, TaggedError } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type { SafeDb } from "@/api/db/safe-db";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  chatMessages,
  chatThreads,
  entities,
  organizationFileObjects,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { uploadEntityHandler } from "@/api/handlers/entities/upload";
import { UPLOAD_ENTITY_ORIGIN } from "@/api/handlers/entities/upload-origin";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { reconcileBufferObjectCleanupIntents } from "@/api/lib/buffer-intent-reconciliation";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { deleteOrganizationFilesWithSignal } from "@/api/lib/files/delete-organization-file";
import type { writeOrganizationFile } from "@/api/lib/files/organization-file-usage";
import { LIMITS } from "@/api/lib/limits";
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

type UploadTestOptions = {
  recordAuditEvent?: AuditRecorder;
  safeDb?: SafeDb;
  generatedDraft?: Parameters<typeof uploadEntityHandler>[0]["generatedDraft"];
};

const upload = async ({
  recordAuditEvent = acceptedAudit,
  safeDb = memberSafeDb(),
  generatedDraft,
}: UploadTestOptions = {}) =>
  await Result.gen(() =>
    uploadEntityHandler({
      safeDb,
      fileUsageDb: fileUsageDb(),
      processEntity: async () => await Promise.resolve(),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      recordAuditEvent,
      ...(generatedDraft === undefined ? {} : { generatedDraft }),
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

// The scheduler reconciles on the root connection: object keys and retry
// metadata stay outside the request role's column grants.
const rootSafeDb = () =>
  asTestRaw<SafeDb>(
    async (run: Parameters<SafeDb>[0]) =>
      await Result.tryPromise(
        async () => await testDb.transaction(asTestRaw(run)),
      ),
  );

const reconcile = async () =>
  await reconcileBufferObjectCleanupIntents({
    safeDb: rootSafeDb(),
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

const configureStore = (flag: boolean, writeTimeoutMs?: number) => {
  env.FEATURE_FILE_USAGE_LIMITS = flag;
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = flag;
  const store = startFakeS3();
  configureS3ForTesting({
    endpoint: store.endpoint,
    ...(writeTimeoutMs === undefined ? {} : { writeTimeoutMs }),
  });
  return store;
};

const defineFlagTests = (flag: boolean) => {
  describe(`multipart cleanup with file usage limits ${String(flag)}`, () => {
    test("reconciliation deletes a first PUT that finishes after retry success and transaction refusal", async () => {
      const store = configureStore(flag, 1000);
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
      const pending = upload({ recordAuditEvent: refuseAudit });
      try {
        await Promise.race([
          hold.reached,
          pending.then(() => panic("Upload finished before the PUT barrier")),
        ]);
        const result = await pending;
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.cause).toBe(refusal);
        }
        expect(auditCalls).toBe(1);
        expect(await entityCount()).toBe(before);
        const puts = putRequests(store);
        expect(puts.length).toBeGreaterThan(0);
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
        if (hold.isReached) {
          await hold.completed;
        }
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
        if (result.isErr()) {
          expect(result.error).toMatchObject({ status: 503 });
        }
        expect(await entityCount()).toBe(before);
        const puts = putRequests(store);
        expect(puts.length).toBeGreaterThan(0);
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
        const result = await upload({
          recordAuditEvent: async () => {
            throw refusal;
          },
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.cause).toBe(refusal);
        }
        expect(await entityCount()).toBe(before);
        expect(putRequests(store).length).toBeGreaterThan(0);
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
        const result = await upload({
          recordAuditEvent: async () => {
            throw refusal;
          },
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

    if (flag) {
      test("a prewrite quota refusal performs no object deletion", async () => {
        const store = configureStore(flag);
        await testDb
          .update(usagePolicies)
          .set({ storageBytesPerAssignment: 0n })
          .where(eq(usagePolicies.id, policyId));
        try {
          const result = await upload();
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error).toMatchObject({
              status: 413,
              message: "Organization file capacity exceeded",
            });
          }
          expect(putRequests(store)).toHaveLength(0);
          expect(
            store.requests.filter(({ method }) => method === "DELETE"),
          ).toHaveLength(0);
          expect(await intentRows()).toHaveLength(0);
          expect(await reconcile()).toBe(0);
        } finally {
          store.stop();
          await testDb
            .update(usagePolicies)
            .set({ storageBytesPerAssignment: 1_000_000n })
            .where(eq(usagePolicies.id, policyId));
          await testDb
            .delete(bufferObjectCleanupIntents)
            .where(eq(bufferObjectCleanupIntents.organizationId, ids.orgA));
        }
      });
    }

    test("lost acknowledgement after publication commit keeps the published bytes", async () => {
      const store = configureStore(flag);
      const realDb = memberSafeDb();
      let committed = false;
      const lostCommitAck: SafeDb = async (run, retry) => {
        const result = await realDb(run, retry);
        if (
          result.isOk() &&
          typeof result.value === "object" &&
          result.value !== null &&
          "status" in result.value &&
          result.value.status === "created"
        ) {
          committed = true;
          return Result.err(
            new DatabaseError({ message: "Commit acknowledgement lost" }),
          );
        }
        return result;
      };
      const before = await entityCount();
      try {
        const result = await upload({ safeDb: lostCommitAck });
        expect(committed).toBe(true);
        expect(result.isErr()).toBe(true);
        expect(await entityCount()).toBe(before + 1);
        expect(await intentRows()).toHaveLength(0);
        expect(store.objects.size).toBe(1);
        expect(
          store.requests.filter(({ method }) => method === "DELETE"),
        ).toHaveLength(0);
      } finally {
        store.stop();
      }
    });

    test("a committed entity-cap refusal retains ownership of a late PUT", async () => {
      const store = configureStore(flag, 1000);
      const hold = store.holdNext({ method: "PUT", keyIncludes: ids.orgA });
      const pending = upload();
      try {
        await Promise.race([
          hold.reached,
          pending.then(() => panic("Upload finished before the PUT barrier")),
        ]);
        await testDb.execute(
          sql`INSERT INTO entities (id, workspace_id, name) SELECT gen_random_uuid(), ${ids.wsA1}, 'cleanup-cap-fixture' FROM generate_series(1, ${LIMITS.entitiesCount})`,
        );
        expect(await entityCount()).toBeGreaterThanOrEqual(
          LIMITS.entitiesCount,
        );
        const result = await pending;
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error).toMatchObject({
            status: 400,
            message: "Entities limit reached",
          });
        }
        const sourceKey =
          putRequests(store).at(0)?.key ?? panic("Expected a PUT request");
        expect(await intentRows()).toMatchObject([
          {
            objectKey: sourceKey,
            status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
          },
        ]);
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
        if (flag) {
          expect(
            await testDb
              .select()
              .from(organizationFileObjects)
              .where(eq(organizationFileObjects.objectKey, sourceKey)),
          ).toHaveLength(0);
        }
      } finally {
        hold.release();
        if (hold.isReached) {
          await hold.completed;
        }
        store.stop();
        await testDb
          .delete(entities)
          .where(
            and(
              eq(entities.workspaceId, ids.wsA1),
              eq(entities.name, "cleanup-cap-fixture"),
            ),
          );
        await testDb
          .delete(bufferObjectCleanupIntents)
          .where(eq(bufferObjectCleanupIntents.organizationId, ids.orgA));
      }
    });

    test("a committed draft replay retains ownership of its late PUT", async () => {
      const store = configureStore(flag, 1000);
      const threadId = createSafeId<"chatThread">();
      const messageId = createSafeId<"chatMessage">();
      const generatedDraft = {
        threadId,
        messageId,
        toolCallId: "cleanup-draft",
        threadWorkspaceId: ids.wsA1,
        contentSha256Hex: hashSha256Hex("Upload cleanup regression bytes"),
      };
      await testDb.insert(chatThreads).values({
        id: threadId,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        organizationId: ids.orgA,
        title: "Cleanup replay fixture",
      });
      await testDb.insert(chatMessages).values({
        id: messageId,
        threadId,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        role: "assistant",
        content: toPersistedChatMessageContentV3({
          data: [
            {
              type: "tool-call",
              id: generatedDraft.toolCallId,
              name: "create-document",
              arguments: "{}",
              input: {},
              state: "complete",
              output: {
                success: true,
                destination: "draft",
                fileName: "cleanup.txt",
              },
            },
          ],
        }),
      });
      const hold = store.holdNext({ method: "PUT", keyIncludes: ids.orgA });
      const pending = upload({ generatedDraft });
      const before = await entityCount();
      try {
        await Promise.race([
          hold.reached,
          pending.then(() => panic("Upload finished before the PUT barrier")),
        ]);
        const winner = await upload({ generatedDraft });
        expect(winner.isOk()).toBe(true);
        const replay = await pending;
        expect(replay).toEqual(winner);
        expect(await entityCount()).toBe(before + 1);
        const sourceKey =
          putRequests(store).at(0)?.key ?? panic("Expected a PUT request");
        expect(await intentRows()).toMatchObject([
          {
            objectKey: sourceKey,
            status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
          },
        ]);
        hold.release();
        await hold.completed;
        await makeCleanupDue();
        expect(await reconcile()).toBe(1);
        expect(store.objects.has(`${envBase.S3_BUCKET}/${sourceKey}`)).toBe(
          false,
        );
        expect(store.objects.size).toBe(1);
      } finally {
        hold.release();
        if (hold.isReached) {
          await hold.completed;
        }
        store.stop();
        await testDb.delete(chatThreads).where(eq(chatThreads.id, threadId));
        await testDb
          .delete(bufferObjectCleanupIntents)
          .where(eq(bufferObjectCleanupIntents.organizationId, ids.orgA));
      }
    });

    test("reconciler preemption between PUT and publication refuses publication", async () => {
      const store = configureStore(flag, 1000);
      const hold = store.holdNext({ method: "PUT", keyIncludes: ids.orgA });
      const before = await entityCount();
      const pending = upload();
      try {
        await Promise.race([
          hold.reached,
          pending.then(() => panic("Upload finished before the PUT barrier")),
        ]);
        await makeCleanupDue();
        expect(await reconcile()).toBe(1);
        expect(await intentRows()).toMatchObject([
          { status: BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING },
        ]);
        hold.release();
        await hold.completed;
        const result = await pending;
        expect(result.isErr()).toBe(true);
        expect(await entityCount()).toBe(before);
      } finally {
        hold.release();
        if (hold.isReached) {
          await hold.completed;
        }
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
        const result = await upload({ recordAuditEvent: audited });
        expect(result.isOk()).toBe(true);
        expect(auditCalls).toBe(1);
        expect(await entityCount()).toBe(before + 1);
        expect(await intentRows()).toHaveLength(0);
        const puts = putRequests(store);
        expect(puts.length).toBeGreaterThan(0);
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
