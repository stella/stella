import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { deleteOrganizationFilesWithSignal } from "@/api/lib/files/delete-organization-file";
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
const priorFlag = envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  fake = startFakeS3();
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
});

afterAll(async () => {
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorFlag;
  fake.stop();
  await testDb
    .delete(organizationFileObjects)
    .where(eq(organizationFileObjects.organizationId, ids.orgA));
  await testDb
    .delete(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, ids.orgA));
  await releaseTestDb();
});

const seedObjects = async (count: number, name: string) => {
  await testDb
    .delete(organizationFileObjects)
    .where(eq(organizationFileObjects.organizationId, ids.orgA));
  await testDb
    .insert(organizationFileUsage)
    .values({
      organizationId: ids.orgA,
      committedBytes: BigInt(count),
    })
    .onConflictDoUpdate({
      target: organizationFileUsage.organizationId,
      set: { committedBytes: BigInt(count), reservedBytes: 0n },
    });
  const keys = Array.from(
    { length: count },
    (_, index) => `${ids.orgA}/${name}/${index}`,
  );
  await testDb.insert(organizationFileObjects).values(
    keys.map((objectKey) => ({
      organizationId: ids.orgA,
      objectKey,
      sizeBytes: 1n,
      status: "committed" as const,
    })),
  );
  for (const key of keys) {
    fake.put(envBase.S3_BUCKET, key, "x");
  }
  return keys;
};

const committedBytes = async () =>
  await testDb
    .select({
      committedBytes: organizationFileUsage.committedBytes,
    })
    .from(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, ids.orgA))
    .then((rows) => rows.at(0)?.committedBytes);

const options = () => ({
  fileUsageDb:
    asTestRaw<
      NonNullable<
        NonNullable<
          Parameters<typeof deleteOrganizationFilesWithSignal>[2]
        >["fileUsageDb"]
      >
    >(testDb),
});

describe("chunked organization file deletion", () => {
  test("settles earlier chunks before a later chunk finishes or fails", async () => {
    const keys = await seedObjects(52, "partial-failure");
    const failedKey = keys.at(50)!;
    const heldKey = keys.at(51)!;
    fake.failNext({
      method: "DELETE",
      key: failedKey,
      status: 403,
      code: "AccessDenied",
    });
    const hold = fake.holdNext({ method: "DELETE", keyIncludes: heldKey });
    const deleting = deleteOrganizationFilesWithSignal(
      keys,
      new AbortController().signal,
      options(),
    );
    await hold.reached;
    try {
      expect(await committedBytes()).toBe(2n);
    } finally {
      hold.release();
      await deleting;
    }
    const result = await deleting;
    expect(Result.isError(result)).toBe(true);
    expect(await committedBytes()).toBe(1n);
    expect(fake.objects.has(`${envBase.S3_BUCKET}/${failedKey}`)).toBe(true);
    const remaining = await testDb
      .select({ objectKey: organizationFileObjects.objectKey })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.organizationId, ids.orgA));
    expect(remaining.map(({ objectKey }) => objectKey)).toEqual([failedKey]);
    expect(
      Result.isOk(
        await deleteOrganizationFilesWithSignal(
          keys,
          new AbortController().signal,
          options(),
        ),
      ),
    ).toBe(true);
    expect(await committedBytes()).toBe(0n);
  });

  test("gives each chunk its own timeout and preserves outer cancellation", async () => {
    const keys = await seedObjects(51, "chunk-signals");
    const timeouts: AbortController[] = [];
    const chunkSignals: AbortSignal[] = [];
    const originalAny = AbortSignal.any.bind(AbortSignal);
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const timeout = new AbortController();
      timeouts.push(timeout);
      return timeout.signal;
    });
    const anySpy = spyOn(AbortSignal, "any").mockImplementation((signals) => {
      const signal = originalAny(signals);
      chunkSignals.push(signal);
      return signal;
    });
    const outer = new AbortController();
    const hold = fake.holdNext({ method: "DELETE", keyIncludes: keys.at(50)! });
    const deleting = deleteOrganizationFilesWithSignal(
      keys,
      outer.signal,
      options(),
    );
    await hold.reached;
    try {
      expect(timeoutSpy.mock.calls).toEqual([[30_000], [30_000]]);
      expect(chunkSignals).toHaveLength(2);
      timeouts.at(0)?.abort();
      expect(chunkSignals.at(0)?.aborted).toBe(true);
      expect(chunkSignals.at(1)?.aborted).toBe(false);
      outer.abort();
      expect(chunkSignals.at(1)?.aborted).toBe(true);
    } finally {
      hold.release();
      await deleting;
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
    }
    expect(Result.isError(await deleting)).toBe(true);
    expect(await committedBytes()).toBe(1n);
  });
});
