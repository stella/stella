import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import {
  fields,
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { createFileKey } from "@/api/lib/file-key";
import {
  reconcileOrganizationFileObject,
  reserveOrganizationFileBytes,
} from "@/api/lib/files/organization-file-usage";
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
const priorWorkerFlag = envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
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
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
});

afterAll(async () => {
  env.FEATURE_FILE_USAGE_LIMITS = priorFlag;
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorWorkerFlag;
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
      mismatched: 0,
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
    ).toEqual({
      scanned: 0,
      committed: 0,
      deleted: 0,
      released: 0,
      mismatched: 0,
    });
  });

  test("settles an abandoned overwrite using its pending size", async () => {
    const key = `${ids.orgA}/${ids.wsA1}/overwrite.pdf`;
    (
      await reconcileOrganizationFileObject(
        {
          organizationId: ids.orgA,
          objectKey: key,
          sizeBytes: 13,
        },
        db(),
      )
    ).unwrap();
    fake.put(envBase.S3_BUCKET, key, new Uint8Array(13), undefined, new Date());
    const overwrite = await reserveOrganizationFileBytes(
      { organizationId: ids.orgA, objectKey: key, sizeBytes: 19 },
      db(),
    );
    expect(Result.isOk(overwrite)).toBe(true);
    fake.put(envBase.S3_BUCKET, key, new Uint8Array(19), undefined, new Date());
    await ageReservation(key);

    const settled = (
      await reconcileAbandonedOrganizationFileReservations({
        db: db(),
        organizationId: ids.orgA,
      })
    ).unwrap();
    expect(settled).toEqual({
      scanned: 1,
      committed: 1,
      deleted: 0,
      released: 0,
      mismatched: 0,
    });
    const row = await testDb
      .select()
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.objectKey, key))
      .then((rows) => rows.at(0));
    expect(row).toMatchObject({
      status: "committed",
      sizeBytes: 19n,
      pendingSizeBytes: null,
      writeId: null,
    });
    expect(fake.objects.has(`${envBase.S3_BUCKET}/${key}`)).toBe(true);
    const usage = await testDb
      .select()
      .from(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, ids.orgA))
      .then((rows) => rows.at(0));
    expect(usage?.reservedBytes).toBe(0n);
  });

  test("a same-size overwrite settles only after its content hash matches", async () => {
    const key = `${ids.orgA}/${ids.wsA1}/same-size-overwrite.pdf`;
    const expectedBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const expectedSha256Hex = hashSha256Hex(expectedBytes);
    (
      await reconcileOrganizationFileObject(
        { organizationId: ids.orgA, objectKey: key, sizeBytes: 5 },
        db(),
      )
    ).unwrap();
    const overwrite = await reserveOrganizationFileBytes(
      {
        organizationId: ids.orgA,
        objectKey: key,
        sizeBytes: 5,
        contentSha256Hex: expectedSha256Hex,
      },
      db(),
    );
    expect(Result.isOk(overwrite)).toBe(true);
    fake.put(
      envBase.S3_BUCKET,
      key,
      new Uint8Array([5, 4, 3, 2, 1]),
      undefined,
      new Date(0),
    );
    await ageReservation(key);

    const first = (
      await reconcileAbandonedOrganizationFileReservations({
        db: db(),
        organizationId: ids.orgA,
      })
    ).unwrap();
    expect(first).toEqual({
      scanned: 1,
      committed: 0,
      deleted: 0,
      released: 0,
      mismatched: 1,
    });
    fake.put(envBase.S3_BUCKET, key, expectedBytes, undefined, new Date(0));
    await ageReservation(key);
    const second = (
      await reconcileAbandonedOrganizationFileReservations({
        db: db(),
        organizationId: ids.orgA,
      })
    ).unwrap();
    expect(second).toEqual({
      scanned: 1,
      committed: 1,
      deleted: 0,
      released: 0,
      mismatched: 0,
    });
    const row = await testDb
      .select({
        status: organizationFileObjects.status,
        pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
        writeId: organizationFileObjects.writeId,
      })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.objectKey, key))
      .then((rows) => rows.at(0));
    expect(row).toEqual({
      status: "committed",
      pendingSizeBytes: null,
      writeId: null,
    });
  });

  test("a mismatched referenced object does not block later reservations", async () => {
    const original = await testDb
      .select({ content: fields.content })
      .from(fields)
      .where(eq(fields.id, ids.fileFieldA1))
      .then((rows) => rows.at(0));
    expect(original?.content.type).toBe("file");
    if (!original || original.content.type !== "file") {
      return;
    }
    const mismatchFileId = Bun.randomUUIDv7();
    const mismatchKey = createFileKey({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      fileId: mismatchFileId,
      mimeType: "application/pdf",
    });
    const laterKey = createFileKey({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      fileId: Bun.randomUUIDv7(),
      mimeType: "application/pdf",
    });
    await testDb
      .update(fields)
      .set({ content: { ...original.content, id: mismatchFileId } })
      .where(eq(fields.id, ids.fileFieldA1));
    try {
      const mismatch = await reserveOrganizationFileBytes(
        { organizationId: ids.orgA, objectKey: mismatchKey, sizeBytes: 11 },
        db(),
      );
      const later = await reserveOrganizationFileBytes(
        { organizationId: ids.orgA, objectKey: laterKey, sizeBytes: 9 },
        db(),
      );
      expect(Result.isOk(mismatch)).toBe(true);
      expect(Result.isOk(later)).toBe(true);
      fake.put(
        envBase.S3_BUCKET,
        mismatchKey,
        new Uint8Array(10),
        undefined,
        new Date(),
      );
      fake.put(envBase.S3_BUCKET, laterKey, "unclaimed", undefined, new Date());
      await ageReservation(mismatchKey);
      await ageReservation(laterKey);

      const settled = (
        await reconcileAbandonedOrganizationFileReservations({
          db: db(),
          organizationId: ids.orgA,
        })
      ).unwrap();
      expect(settled).toEqual({
        scanned: 2,
        committed: 0,
        deleted: 1,
        released: 0,
        mismatched: 1,
      });
      const pending = await testDb
        .select({ writeId: organizationFileObjects.writeId })
        .from(organizationFileObjects)
        .where(eq(organizationFileObjects.objectKey, mismatchKey))
        .then((rows) => rows.at(0));
      expect(pending?.writeId).toBeTruthy();
      expect(fake.objects.has(`${envBase.S3_BUCKET}/${mismatchKey}`)).toBe(
        true,
      );
      expect(fake.objects.has(`${envBase.S3_BUCKET}/${laterKey}`)).toBe(false);
    } finally {
      await testDb
        .update(fields)
        .set({ content: original.content })
        .where(eq(fields.id, ids.fileFieldA1));
    }
  });

  test("the periodic reservation sweep runs only when file usage is enabled", async () => {
    let calls = 0;
    let mismatchWarnings = 0;
    const task = createReconcileOrganizationFileReservationsTask({
      reconcile: async () => {
        calls += 1;
        return Result.ok({
          scanned: 0,
          committed: 0,
          deleted: 0,
          released: 0,
          mismatched: 1,
        });
      },
    });
    const context = asTestRaw<Parameters<SchedulerTask>[0]>({
      db: testDb,
      logger: {
        info: () => undefined,
        warn: () => {
          mismatchWarnings += 1;
        },
      },
      signal: new AbortController().signal,
    });
    env.FEATURE_FILE_USAGE_LIMITS = false;
    envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = false;
    await task(context);
    expect(calls).toBe(0);
    expect(mismatchWarnings).toBe(0);
    env.FEATURE_FILE_USAGE_LIMITS = true;
    envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
    await task(context);
    expect(calls).toBe(1);
    expect(mismatchWarnings).toBe(1);
  });
});
