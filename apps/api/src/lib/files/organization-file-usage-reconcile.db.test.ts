import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { createFileKey } from "@/api/lib/file-key";
import { reserveOrganizationFileBytes } from "@/api/lib/files/organization-file-usage";
import { reconcileAbandonedOrganizationFileReservations } from "@/api/lib/files/organization-file-usage-reconcile";
import { createReconcileOrganizationFileReservationsTask } from "@/api/lib/scheduler/tasks/organization-file-reservation-reconcile";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
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

let testDb: TestDatabase;
let ids: TestIds;
let fake: FakeS3;
const priorFlag = env.FEATURE_FILE_USAGE_LIMITS;
const db = () =>
  asTestRaw<
    Parameters<typeof reconcileAbandonedOrganizationFileReservations>[0]["db"]
  >(testDb);

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  fake = startFakeS3();
  env.FEATURE_FILE_USAGE_LIMITS = true;
});

afterAll(async () => {
  env.FEATURE_FILE_USAGE_LIMITS = priorFlag;
  fake.stop();
  await testDb
    .delete(organizationFileObjects)
    .where(eq(organizationFileObjects.organizationId, ids.orgA));
  await testDb
    .delete(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, ids.orgA));
  await releaseTestDb();
});

const ageReservation = async (objectKey: string) => {
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  await testDb
    .update(organizationFileObjects)
    .set({ reservationStartedAt: old, updatedAt: old })
    .where(eq(organizationFileObjects.objectKey, objectKey));
};

describe("abandoned organization file reservations", () => {
  test("settles abandoned fresh keys by committing referenced bytes and deleting orphan bytes", async () => {
    const referencedKey = createFileKey({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      fileId: ids.fileObjectA1,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const orphanKey = createFileKey({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      fileId: Bun.randomUUIDv7(),
      mimeType: "application/pdf",
    });
    const referenced = await reserveOrganizationFileBytes(
      {
        organizationId: ids.orgA,
        objectKey: referencedKey,
        sizeBytes: 1024,
      },
      db(),
    );
    const orphan = await reserveOrganizationFileBytes(
      { organizationId: ids.orgA, objectKey: orphanKey, sizeBytes: 9 },
      db(),
    );
    expect(Result.isOk(referenced)).toBe(true);
    expect(Result.isOk(orphan)).toBe(true);
    fake.put(
      envBase.S3_BUCKET,
      referencedKey,
      new Uint8Array(1024),
      undefined,
      new Date(),
    );
    fake.put(envBase.S3_BUCKET, orphanKey, "unclaimed", undefined, new Date());
    await ageReservation(referencedKey);
    await ageReservation(orphanKey);

    const first = (
      await reconcileAbandonedOrganizationFileReservations({
        db: db(),
        organizationId: ids.orgA,
      })
    ).unwrap();
    expect(first).toEqual({
      scanned: 2,
      committed: 1,
      deleted: 1,
      released: 0,
    });
    const rows = await testDb
      .select({
        objectKey: organizationFileObjects.objectKey,
        status: organizationFileObjects.status,
      })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.organizationId, ids.orgA));
    expect(rows).toEqual([{ objectKey: referencedKey, status: "committed" }]);
    expect(fake.objects.has(`${envBase.S3_BUCKET}/${referencedKey}`)).toBe(
      true,
    );
    expect(fake.objects.has(`${envBase.S3_BUCKET}/${orphanKey}`)).toBe(false);
    const usage = await testDb
      .select()
      .from(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, ids.orgA))
      .then((matches) => matches.at(0));
    expect(usage?.committedBytes).toBe(1024n);
    expect(usage?.reservedBytes).toBe(0n);
    expect(
      (
        await reconcileAbandonedOrganizationFileReservations({
          db: db(),
          organizationId: ids.orgA,
        })
      ).unwrap(),
    ).toEqual({ scanned: 0, committed: 0, deleted: 0, released: 0 });
  });

  test("the periodic reservation sweep runs only when file usage is enabled", async () => {
    let calls = 0;
    const task = createReconcileOrganizationFileReservationsTask({
      reconcile: async () => {
        calls += 1;
        return Result.ok({ scanned: 0, committed: 0, deleted: 0, released: 0 });
      },
    });
    const context = asTestRaw<Parameters<SchedulerTask>[0]>({
      db: testDb,
      logger: { info: () => undefined },
      signal: new AbortController().signal,
    });
    env.FEATURE_FILE_USAGE_LIMITS = false;
    await task(context);
    expect(calls).toBe(0);
    env.FEATURE_FILE_USAGE_LIMITS = true;
    await task(context);
    expect(calls).toBe(1);
  });
});
