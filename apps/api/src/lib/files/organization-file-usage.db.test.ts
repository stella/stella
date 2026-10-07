import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  organizationFileObjects,
  organizationFileUsage,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { createSafeId } from "@/api/lib/branded-types";
import { copyOrganizationFiles } from "@/api/lib/files/copy-organization-files";
import {
  deleteOrganizationFilesWithSignal,
  deleteOrganizationFileWithSignal,
} from "@/api/lib/files/delete-organization-file";
import {
  authorizeOrganizationFileWrite,
  runCheckedOrganizationFileWrite,
  commitOrganizationFileBytes,
  commitOrganizationFilesBytes,
  copyOrganizationFile,
  reconcileOrganizationFileObject,
  reconcileOrganizationFileObjects,
  releaseOrganizationFileBytes,
  releaseOrganizationFilesBytes,
  removeOrganizationFileBytes,
  removeOrganizationFilesBytes,
  reserveOrganizationFileBytes,
  reserveOrganizationFilesBytes,
  writeOrganizationFile,
  writeOrganizationFiles,
} from "@/api/lib/files/organization-file-usage";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
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
const priorFlag = env.FEATURE_FILE_USAGE_LIMITS;
const priorWorkerFlag = envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
const policyId = createSafeId<"usagePolicy">();
const entitlementId = createSafeId<"usageEntitlement">();
const assignmentId = createSafeId<"usageSeatAssignment">();
const db = () =>
  asTestRaw<NonNullable<Parameters<typeof reserveOrganizationFileBytes>[1]>>(
    testDb,
  );
const input = (objectKey: string, sizeBytes: number) => ({
  organizationId: ids.orgA,
  objectKey,
  sizeBytes,
});
const counter = async () =>
  await testDb
    .select()
    .from(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, ids.orgA))
    .then((rows) => rows.at(0));
const releaseConfirmedAbsentReservation = async (key: string) => {
  const pending = await testDb
    .select({ writeId: organizationFileObjects.writeId })
    .from(organizationFileObjects)
    .where(eq(organizationFileObjects.objectKey, key))
    .then((rows) => rows.at(0));
  expect(pending?.writeId).toBeTruthy();
  if (!pending?.writeId) {
    return;
  }
  await releaseOrganizationFileBytes(
    {
      status: "reserved",
      organizationId: ids.orgA,
      objectKey: key,
      writeId: pending.writeId,
    },
    db(),
  );
};

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  const now = Date.now();
  await testDb.insert(usagePolicies).values({
    id: policyId,
    policyKey: `file-usage-${policyId}`.slice(0, 64),
    displayName: "File usage fixture",
    monthlyUsageUnits: 0,
    storageBytesPerAssignment: 29n,
  });
  await testDb.insert(usageEntitlements).values({
    id: entitlementId,
    organizationId: ids.orgA,
    usagePolicyId: policyId,
    status: "active",
    seats: 1,
    currentPeriodStart: new Date(now - 60_000),
    currentPeriodEnd: new Date(now + 60_000),
    source: "manual",
  });
  await testDb.insert(usageSeatAssignments).values({
    id: assignmentId,
    organizationId: ids.orgA,
    userId: ids.userA1,
  });
  env.FEATURE_FILE_USAGE_LIMITS = true;
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
});

afterAll(async () => {
  env.FEATURE_FILE_USAGE_LIMITS = priorFlag;
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorWorkerFlag;
  await testDb
    .delete(organizationFileObjects)
    .where(eq(organizationFileObjects.organizationId, ids.orgA));
  await testDb
    .delete(organizationFileObjects)
    .where(eq(organizationFileObjects.organizationId, ids.orgB));
  await testDb
    .delete(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, ids.orgA));
  await testDb
    .delete(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, ids.orgB));
  await testDb
    .delete(usageSeatAssignments)
    .where(eq(usageSeatAssignments.id, assignmentId));
  await testDb
    .delete(usageEntitlements)
    .where(eq(usageEntitlements.id, entitlementId));
  await testDb.delete(usagePolicies).where(eq(usagePolicies.id, policyId));
  await releaseTestDb();
});

describe("organization file usage", () => {
  test("each stored object execution family admits checked input and refuses unavailable input", async () => {
    const attempted: string[] = [];
    const key = (family: string, allowed: boolean) =>
      `fixture/evidence-${family}-${allowed}`;
    const runWrite = (family: string, allowed: boolean) => ({
      ...input(key(family, allowed), allowed ? 1 : 1000),
      write: async () => {
        attempted.push(key(family, allowed));
        return await Promise.resolve("stored");
      },
      db: db(),
    });
    const runCopy = (family: string, allowed: boolean) => ({
      ...input(key(family, allowed), allowed ? 1 : 1000),
      copy: async () => {
        attempted.push(key(family, allowed));
        return await Promise.resolve(Result.ok("stored"));
      },
      db: db(),
    });
    const families = {
      write: async (allowed: boolean) =>
        await writeOrganizationFile(runWrite("write", allowed)),
      copy: async (allowed: boolean) =>
        await copyOrganizationFile(runCopy("copy", allowed)),
      batchWrite: async (allowed: boolean) =>
        await writeOrganizationFiles([runWrite("batchWrite", allowed)], db()),
      batchCopy: async (allowed: boolean) =>
        await copyOrganizationFiles({
          inputs: [runCopy("batchCopy", allowed)],
          concurrency: 1,
          db: db(),
        }),
    };
    for (const [family, run] of Object.entries(families)) {
      try {
        expect((await run(true)).status).toBe("ok");
        const denied = await run(false);
        expect(denied.status).toBe("error");
        if (denied.status === "error") {
          expect(denied.error.reason).toBe("capacity_exceeded");
        }
        expect(attempted).toContain(key(family, true));
        expect(attempted).not.toContain(key(family, false));
      } finally {
        await removeOrganizationFileBytes(key(family, true), db());
      }
    }
  });

  test("reserved execution retains the checked object and nested input", async () => {
    const objectKey = "fixture/evidence-snapshot";
    const operation = {
      ...input(objectKey, 3),
      metadata: { label: "authorized" },
      write: async () => await Promise.resolve("stored"),
      db: db(),
    };
    try {
      const authorization = await authorizeOrganizationFileWrite(
        operation,
        operation.db,
      );
      if (Result.isError(authorization)) {
        panic("Successful evidence fixture was refused", authorization.error);
      }
      operation.objectKey = "fixture/evidence-changed";
      operation.sizeBytes = 7;
      operation.metadata.label = "changed";
      const written = await authorization.value.execute(async (checked) => {
        expect(checked.input.value.operation.objectKey).toBe(objectKey);
        expect(checked.input.value.operation.sizeBytes).toBe(3);
        expect(checked.input.value.operation.metadata.label).toBe("authorized");
        expect(Object.isFrozen(checked.input.value.operation.metadata)).toBe(
          true,
        );
        checked.scratch.operation.objectKey = "fixture/execution-changed";
        checked.scratch.operation.sizeBytes = 99;
        checked.scratch.operation.metadata.label = "scratch-only";
        checked.scratch.operation.write = async () =>
          await Promise.resolve("wrong write");
        return await runCheckedOrganizationFileWrite({
          ...checked,
          input: { ...checked.input, value: checked.scratch },
        });
      });
      expect(written).toEqual(Result.ok("stored"));
      const rows = await testDb
        .select()
        .from(organizationFileObjects)
        .where(eq(organizationFileObjects.objectKey, objectKey));
      expect(rows.at(0)?.sizeBytes).toBe(3n);
    } finally {
      await removeOrganizationFileBytes(objectKey, db());
    }
  });

  test("reservation and failure release restore available bytes", async () => {
    const first = await reserveOrganizationFileBytes(
      input("fixture/release-a", 13),
      db(),
    );
    expect(Result.isOk(first)).toBe(true);
    if (Result.isError(first)) {
      return;
    }
    expect((await counter())?.reservedBytes).toBe(13n);

    const blocked = await reserveOrganizationFileBytes(
      input("fixture/release-b", 17),
      db(),
    );
    expect(Result.isError(blocked)).toBe(true);
    if (Result.isError(blocked)) {
      expect(blocked.error.reason).toBe("capacity_exceeded");
    }

    expect(
      Result.isOk(await releaseOrganizationFileBytes(first.value, db())),
    ).toBe(true);
    expect((await counter())?.reservedBytes).toBe(0n);
    const second = await reserveOrganizationFileBytes(
      input("fixture/release-b", 17),
      db(),
    );
    expect(Result.isOk(second)).toBe(true);
    if (Result.isOk(second)) {
      await releaseOrganizationFileBytes(second.value, db());
    }
  });

  test("uncertain failure retains a reservation until confirmed cleanup", async () => {
    const failed = await writeOrganizationFile({
      ...input("fixture/write", 11),
      db: db(),
      write: async () => {
        throw new Error("provider failed");
      },
    });
    expect(Result.isError(failed)).toBe(true);
    expect((await counter())?.reservedBytes).toBe(11n);
    await removeOrganizationFileBytes("fixture/write", db());
    expect((await counter())?.reservedBytes).toBe(11n);
    await releaseConfirmedAbsentReservation("fixture/write");
    expect((await counter())?.reservedBytes).toBe(0n);

    const written = await writeOrganizationFile({
      ...input("fixture/write", 11),
      db: db(),
      write: async () => "stored",
    });
    expect(Result.isOk(written)).toBe(true);
    expect((await counter())?.committedBytes).toBe(11n);
    const replay = await reserveOrganizationFileBytes(
      input("fixture/write", 11),
      db(),
    );
    expect(replay).toMatchObject({ value: { status: "already_committed" } });
    if (Result.isOk(replay)) {
      await commitOrganizationFileBytes(replay.value, db());
    }
    expect((await counter())?.committedBytes).toBe(11n);
    await removeOrganizationFileBytes("fixture/write", db());
    await removeOrganizationFileBytes("fixture/write", db());
    expect((await counter())?.committedBytes).toBe(0n);
  });

  test("deleting a stored object removes its committed bytes", async () => {
    const key = "fixture/tracked-delete";
    const fake = startFakeS3();
    try {
      fake.put(envBase.S3_BUCKET, key, "stored");
      expect(
        Result.isOk(await reconcileOrganizationFileObject(input(key, 6), db())),
      ).toBe(true);
      expect((await counter())?.committedBytes).toBe(6n);

      const deleted = await deleteOrganizationFileWithSignal(
        key,
        AbortSignal.timeout(10_000),
        { fileUsageDb: db() },
      );
      expect(Result.isOk(deleted)).toBe(true);

      expect(fake.objects.has(`${envBase.S3_BUCKET}/${key}`)).toBe(false);
      expect((await counter())?.committedBytes).toBe(0n);
    } finally {
      fake.stop();
    }
  });

  test("a failed ledger decrement returns an error after storage deletion", async () => {
    const key = "fixture/tracked-delete-ledger-failure";
    const fake = startFakeS3();
    try {
      fake.put(envBase.S3_BUCKET, key, "stored");
      expect(
        Result.isOk(await reconcileOrganizationFileObject(input(key, 6), db())),
      ).toBe(true);

      const unavailableDb = asTestRaw<
        NonNullable<Parameters<typeof reserveOrganizationFileBytes>[1]>
      >({
        transaction: async () => {
          throw new Error("ledger unavailable");
        },
      });
      const deleted = await deleteOrganizationFileWithSignal(
        key,
        AbortSignal.timeout(10_000),
        { fileUsageDb: unavailableDb },
      );

      expect(Result.isError(deleted)).toBe(true);
      expect(fake.objects.has(`${envBase.S3_BUCKET}/${key}`)).toBe(false);
      expect((await counter())?.committedBytes).toBe(6n);
      expect(Result.isOk(await removeOrganizationFileBytes(key, db()))).toBe(
        true,
      );
    } finally {
      fake.stop();
    }
  });

  test("reconciliation is idempotent and corrects changed lengths", async () => {
    const object = input("fixture/reconcile", 7);
    expect(
      Result.isOk(await reconcileOrganizationFileObject(object, db())),
    ).toBe(true);
    expect(
      Result.isOk(await reconcileOrganizationFileObject(object, db())),
    ).toBe(true);
    expect((await counter())?.committedBytes).toBe(7n);
    expect(
      Result.isOk(
        await reconcileOrganizationFileObject(
          { ...object, sizeBytes: 9 },
          db(),
        ),
      ),
    ).toBe(true);
    expect((await counter())?.committedBytes).toBe(9n);
    await removeOrganizationFileBytes(object.objectKey, db());
  });

  test("page reconciliation is a fixed point and skips active writes without losing sibling deltas", async () => {
    const first = input("fixture/page-reconcile-first", 6);
    const second = input("fixture/page-reconcile-second", 5);
    const busy = input("fixture/page-reconcile-busy", 4);
    const added = input("fixture/page-reconcile-added", 7);
    const foreign = {
      ...input("fixture/page-reconcile-foreign", 4),
      organizationId: ids.orgB,
    };
    const conflictSibling = input("fixture/page-reconcile-conflict-sibling", 1);
    expect(
      await reconcileOrganizationFileObjects([first, second, foreign], db()),
    ).toMatchObject({ status: "ok", value: 3 });
    const reservations = await reserveOrganizationFilesBytes(
      [busy, { ...first, sizeBytes: 8 }],
      db(),
    );
    expect(Result.isOk(reservations)).toBe(true);
    if (Result.isError(reservations)) {
      return;
    }
    try {
      const page = [
        { ...busy, sizeBytes: 1 },
        { ...first, sizeBytes: 2 },
        { ...second, sizeBytes: 3 },
        added,
        foreign,
      ];
      expect(await reconcileOrganizationFileObjects(page, db())).toMatchObject({
        status: "ok",
        value: 3,
      });
      expect((await counter())?.committedBytes).toBe(16n);
      expect((await counter())?.reservedBytes).toBe(6n);
      expect(await reconcileOrganizationFileObjects(page, db())).toMatchObject({
        status: "ok",
        value: 3,
      });
      expect((await counter())?.committedBytes).toBe(16n);
      expect((await counter())?.reservedBytes).toBe(6n);
      const conflicted = await reconcileOrganizationFileObjects(
        [conflictSibling, { ...foreign, organizationId: ids.orgA }],
        db(),
      );
      expect(conflicted).toMatchObject({
        status: "error",
        error: { reason: "key_conflict" },
      });
      expect(
        await testDb
          .select()
          .from(organizationFileObjects)
          .where(
            eq(organizationFileObjects.objectKey, conflictSibling.objectKey),
          ),
      ).toHaveLength(0);
      expect((await counter())?.committedBytes).toBe(16n);
      expect((await counter())?.reservedBytes).toBe(6n);
    } finally {
      await releaseOrganizationFilesBytes(reservations.value, db());
      await removeOrganizationFilesBytes(
        [
          first.objectKey,
          second.objectKey,
          added.objectKey,
          foreign.objectKey,
          conflictSibling.objectKey,
        ],
        db(),
      );
    }
  });

  test("zero-byte objects are recorded without consuming capacity", async () => {
    const zero = await reserveOrganizationFileBytes(
      input("fixture/empty", 0),
      db(),
    );
    expect(Result.isOk(zero)).toBe(true);
    if (Result.isError(zero)) {
      return;
    }
    expect(
      Result.isOk(await commitOrganizationFileBytes(zero.value, db())),
    ).toBe(true);
    expect((await counter())?.committedBytes).toBe(0n);
    expect(
      await testDb
        .select({ objectKey: organizationFileObjects.objectKey })
        .from(organizationFileObjects)
        .where(eq(organizationFileObjects.objectKey, "fixture/empty"))
        .then((rows) => rows.at(0)?.objectKey),
    ).toBe("fixture/empty");
    await removeOrganizationFileBytes("fixture/empty", db());
  });

  test("uncertain copy failure retains its reservation", async () => {
    const copied = await copyOrganizationFile({
      ...input("fixture/copy", 23),
      db: db(),
      copy: async () => Result.err(new Error("copy failed")),
    });
    expect(Result.isError(copied)).toBe(true);
    expect((await counter())?.reservedBytes).toBe(23n);
    expect((await counter())?.committedBytes).toBe(0n);
    await removeOrganizationFileBytes("fixture/copy", db());
    expect((await counter())?.reservedBytes).toBe(23n);
    await releaseConfirmedAbsentReservation("fixture/copy");
  });

  test("missing capability leaves writes unbounded but recorded", async () => {
    const object = {
      ...input("fixture/unbounded", 70),
      organizationId: ids.orgB,
    };
    const reserved = await reserveOrganizationFileBytes(object, db());
    expect(Result.isOk(reserved)).toBe(true);
    if (Result.isError(reserved)) {
      return;
    }
    await commitOrganizationFileBytes(reserved.value, db());
    const usage = await testDb
      .select({ committedBytes: organizationFileUsage.committedBytes })
      .from(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, ids.orgB))
      .then((rows) => rows.at(0));
    expect(usage?.committedBytes).toBe(70n);
    await removeOrganizationFileBytes(object.objectKey, db());
  });

  test("configured file capacity remains enforced for non-consumable entitlements", async () => {
    const now = Date.now();
    const cases = [
      {
        status: "active",
        currentPeriodStart: new Date(now - 120_000),
        currentPeriodEnd: new Date(now - 60_000),
      },
      {
        status: "cancelled",
        currentPeriodStart: new Date(now - 60_000),
        currentPeriodEnd: new Date(now + 60_000),
      },
      {
        status: "paused",
        currentPeriodStart: new Date(now - 60_000),
        currentPeriodEnd: new Date(now + 60_000),
      },
      {
        status: "past_due",
        currentPeriodStart: new Date(now - 60_000),
        currentPeriodEnd: new Date(now + 60_000),
      },
    ] as const;
    for (const [index, state] of cases.entries()) {
      await testDb
        .update(usageEntitlements)
        .set(state)
        .where(eq(usageEntitlements.id, entitlementId));
      const reserved = await reserveOrganizationFileBytes(
        input(`fixture/non-consumable-${index}`, 30),
        db(),
      );
      expect(Result.isError(reserved)).toBe(true);
      if (Result.isError(reserved)) {
        expect(reserved.error.reason).toBe("capacity_exceeded");
      }
    }
    await testDb
      .update(usageEntitlements)
      .set({
        status: "active",
        currentPeriodStart: new Date(now - 60_000),
        currentPeriodEnd: new Date(now + 60_000),
      })
      .where(eq(usageEntitlements.id, entitlementId));
  });

  test("capacity reduction permits no-growth overwrites and rejects new objects", async () => {
    const existing = await reserveOrganizationFileBytes(
      input("fixture/over-cap", 17),
      db(),
    );
    expect(Result.isOk(existing)).toBe(true);
    if (Result.isError(existing)) {
      return;
    }
    await commitOrganizationFileBytes(existing.value, db());
    await testDb
      .delete(usageSeatAssignments)
      .where(eq(usageSeatAssignments.id, assignmentId));
    const replacement = await reserveOrganizationFileBytes(
      {
        ...input("fixture/over-cap", 17),
        contentSha256Hex: "a".repeat(64),
      },
      db(),
    );
    expect(replacement).toMatchObject({ value: { status: "reserved" } });
    if (Result.isOk(replacement)) {
      expect(
        Result.isOk(await commitOrganizationFileBytes(replacement.value, db())),
      ).toBe(true);
    }
    const blocked = await reserveOrganizationFileBytes(
      input("fixture/after-reduction", 1),
      db(),
    );
    expect(Result.isError(blocked)).toBe(true);
    if (Result.isError(blocked)) {
      expect(blocked.error.reason).toBe("capacity_exceeded");
    }
    expect((await counter())?.committedBytes).toBe(17n);
    await removeOrganizationFileBytes("fixture/over-cap", db());
    await testDb.insert(usageSeatAssignments).values({
      id: assignmentId,
      organizationId: ids.orgA,
      userId: ids.userA1,
    });
  });

  test("ledger commit failure leaves a recoverable write identity", async () => {
    const fake = startFakeS3();
    const key = "fixture/commit-failure";
    let transactionCount = 0;
    const backingDb = db();
    const failingTransaction: typeof backingDb.transaction = async (fn) => {
      transactionCount += 1;
      if (transactionCount === 2) {
        throw new Error("ledger unavailable");
      }
      return await backingDb.transaction(fn);
    };
    const written = await writeOrganizationFile({
      ...input(key, 9),
      db: { transaction: failingTransaction },
      write: async () => {
        fake.put(envBase.S3_BUCKET, key, "confirmed", undefined, new Date());
        return "confirmed";
      },
    });
    expect(Result.isError(written)).toBe(true);
    const object = await testDb
      .select({ writeId: organizationFileObjects.writeId })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.objectKey, key))
      .then((rows) => rows.at(0));
    expect(object?.writeId).toBeTruthy();
    expect((await counter())?.reservedBytes).toBe(9n);
    await testDb
      .update(organizationFileObjects)
      .set({ reservationStartedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(organizationFileObjects.objectKey, key));
    const recovered = await reserveOrganizationFileBytes(input(key, 9), db());
    expect(Result.isOk(recovered)).toBe(true);
    expect((await counter())?.committedBytes).toBe(9n);
    expect((await counter())?.reservedBytes).toBe(0n);
    await removeOrganizationFileBytes(key, db());
    fake.stop();
  });

  test("an obsolete write identity cannot settle a newer reservation", async () => {
    const original = await reserveOrganizationFileBytes(
      input("fixture/identity", 5),
      db(),
    );
    expect(Result.isOk(original)).toBe(true);
    if (Result.isError(original)) {
      return;
    }
    await releaseOrganizationFileBytes(original.value, db());
    const replacement = await reserveOrganizationFileBytes(
      input("fixture/identity", 8),
      db(),
    );
    expect(Result.isOk(replacement)).toBe(true);
    if (Result.isError(replacement)) {
      return;
    }
    const stale = await commitOrganizationFileBytes(original.value, db());
    expect(Result.isError(stale)).toBe(true);
    expect((await counter())?.reservedBytes).toBe(8n);
    await releaseOrganizationFileBytes(replacement.value, db());
  });

  test("concurrent reservations cannot exceed the organization cap", async () => {
    const attempts = await Promise.all([
      reserveOrganizationFileBytes(input("fixture/race-a", 17), db()),
      reserveOrganizationFileBytes(input("fixture/race-b", 17), db()),
    ]);
    expect(attempts.filter(Result.isOk)).toHaveLength(1);
    const accepted = attempts.find(Result.isOk);
    if (accepted) {
      await releaseOrganizationFileBytes(accepted.value, db());
    }
    expect((await counter())?.reservedBytes).toBe(0n);
  });

  test("replacing a fixed key reserves only growth and restores the old count on failure", async () => {
    const object = input("fixture/overwrite", 13);
    await reconcileOrganizationFileObject(object, db());
    const growing = await reserveOrganizationFileBytes(
      { ...object, sizeBytes: 19 },
      db(),
    );
    expect(Result.isOk(growing)).toBe(true);
    expect((await counter())?.committedBytes).toBe(13n);
    expect((await counter())?.reservedBytes).toBe(6n);
    if (Result.isOk(growing)) {
      await releaseOrganizationFileBytes(growing.value, db());
    }
    expect((await counter())?.committedBytes).toBe(13n);
    expect((await counter())?.reservedBytes).toBe(0n);

    const shrinking = await reserveOrganizationFileBytes(
      { ...object, sizeBytes: 7 },
      db(),
    );
    expect(Result.isOk(shrinking)).toBe(true);
    if (Result.isOk(shrinking)) {
      await commitOrganizationFileBytes(shrinking.value, db());
    }
    expect((await counter())?.committedBytes).toBe(7n);
    await removeOrganizationFileBytes(object.objectKey, db());
  });

  test("batch deletion settles confirmed objects and retains failed objects", async () => {
    const fake = startFakeS3();
    const confirmedKey = "fixture/batch-delete-confirmed";
    const failedKey = "fixture/batch-delete-failed";
    const emptyKeys = Array.from(
      { length: 55 },
      (_, index) => `fixture/batch-delete-empty-${index}`,
    );
    try {
      for (const key of emptyKeys) {
        fake.put(envBase.S3_BUCKET, key, "");
      }
      const emptyReservations = await reserveOrganizationFilesBytes(
        emptyKeys.map((key) => input(key, 0)),
        db(),
      );
      expect(Result.isOk(emptyReservations)).toBe(true);
      if (Result.isError(emptyReservations)) {
        return;
      }
      await commitOrganizationFilesBytes(emptyReservations.value, db());
      fake.put(envBase.S3_BUCKET, confirmedKey, "stored");
      fake.put(envBase.S3_BUCKET, failedKey, "stored");
      await reconcileOrganizationFileObject(input(confirmedKey, 6), db());
      await reconcileOrganizationFileObject(input(failedKey, 6), db());
      fake.failNext({
        method: "DELETE",
        key: failedKey,
        code: "AccessDenied",
        status: 403,
      });
      const deleted = await deleteOrganizationFilesWithSignal(
        [confirmedKey, failedKey, ...emptyKeys],
        AbortSignal.timeout(10_000),
        { fileUsageDb: db() },
      );
      expect(Result.isError(deleted)).toBe(true);
      expect(fake.objects.has(`${envBase.S3_BUCKET}/${confirmedKey}`)).toBe(
        false,
      );
      expect(fake.objects.has(`${envBase.S3_BUCKET}/${failedKey}`)).toBe(true);
      expect((await counter())?.committedBytes).toBe(6n);
      const retried = await deleteOrganizationFilesWithSignal(
        [confirmedKey, failedKey, ...emptyKeys],
        AbortSignal.timeout(10_000),
        { fileUsageDb: db() },
      );
      expect(Result.isOk(retried)).toBe(true);
      expect((await counter())?.committedBytes).toBe(0n);
    } finally {
      fake.stop();
    }
  });

  test("batch capacity is atomic and competing batches cannot overbook", async () => {
    const overCap = await reserveOrganizationFilesBytes(
      [input("fixture/batch-over-a", 17), input("fixture/batch-over-b", 17)],
      db(),
    );
    expect(overCap).toMatchObject({ error: { reason: "capacity_exceeded" } });
    expect((await counter())?.reservedBytes).toBe(0n);
    const attempts = await Promise.all([
      reserveOrganizationFilesBytes(
        [input("fixture/batch-race-a", 9), input("fixture/batch-race-b", 8)],
        db(),
      ),
      reserveOrganizationFilesBytes(
        [input("fixture/batch-race-c", 9), input("fixture/batch-race-d", 8)],
        db(),
      ),
    ]);
    expect(attempts.filter(Result.isOk)).toHaveLength(1);
    const accepted = attempts.find(Result.isOk);
    if (!accepted) {
      return;
    }
    expect((await counter())?.reservedBytes).toBe(17n);
    expect(
      Result.isOk(await releaseOrganizationFilesBytes(accepted.value, db())),
    ).toBe(true);
    expect(
      Result.isOk(await releaseOrganizationFilesBytes(accepted.value, db())),
    ).toBe(true);
    expect((await counter())?.reservedBytes).toBe(0n);
  });

  test("batch settlement preserves replacements and stale identities cannot settle newer writes", async () => {
    const original = await reserveOrganizationFilesBytes(
      [input("fixture/batch-settle-a", 7), input("fixture/batch-settle-b", 5)],
      db(),
    );
    expect(Result.isOk(original)).toBe(true);
    if (Result.isError(original)) {
      return;
    }
    expect(
      Result.isOk(await commitOrganizationFilesBytes(original.value, db())),
    ).toBe(true);
    expect((await counter())?.committedBytes).toBe(12n);
    const replacements = await reserveOrganizationFilesBytes(
      [input("fixture/batch-settle-a", 9), input("fixture/batch-settle-b", 3)],
      db(),
    );
    expect(Result.isOk(replacements)).toBe(true);
    if (Result.isError(replacements)) {
      return;
    }
    expect((await counter())?.reservedBytes).toBe(2n);
    expect(
      await commitOrganizationFilesBytes(original.value, db()),
    ).toMatchObject({
      value: {
        busyObjectKeys: ["fixture/batch-settle-a", "fixture/batch-settle-b"],
      },
    });
    expect(
      Result.isOk(await releaseOrganizationFilesBytes(original.value, db())),
    ).toBe(true);
    expect((await counter())?.reservedBytes).toBe(2n);
    expect(
      Result.isOk(await commitOrganizationFilesBytes(replacements.value, db())),
    ).toBe(true);
    expect((await counter())?.committedBytes).toBe(12n);
    expect((await counter())?.reservedBytes).toBe(0n);
    const keys = ["fixture/batch-settle-a", "fixture/batch-settle-b"];
    expect(Result.isOk(await removeOrganizationFilesBytes(keys, db()))).toBe(
      true,
    );
    expect(Result.isOk(await removeOrganizationFilesBytes(keys, db()))).toBe(
      true,
    );
    expect((await counter())?.committedBytes).toBe(0n);
  });

  test("batch writes commit confirmed successes while uncertain siblings stay reserved", async () => {
    const written = await writeOrganizationFiles(
      [
        { ...input("fixture/batch-success", 4), write: async () => "stored" },
        {
          ...input("fixture/batch-uncertain", 6),
          write: async () => {
            throw new Error("provider timeout");
          },
        },
      ],
      db(),
    );
    expect(Result.isOk(written)).toBe(true);
    if (Result.isOk(written)) {
      expect(written.value).toHaveLength(2);
      expect(written.value.at(0)).toMatchObject({ value: "stored" });
      expect(written.value.at(1)).toMatchObject({
        error: { reason: "storage_unavailable" },
      });
    }
    expect((await counter())?.committedBytes).toBe(4n);
    expect((await counter())?.reservedBytes).toBe(6n);
    await removeOrganizationFilesBytes(
      ["fixture/batch-success", "fixture/batch-uncertain"],
      db(),
    );
    expect((await counter())?.committedBytes).toBe(0n);
    expect((await counter())?.reservedBytes).toBe(6n);
    await releaseConfirmedAbsentReservation("fixture/batch-uncertain");
    expect((await counter())?.reservedBytes).toBe(0n);
  });

  test("copy rounds settle earlier successes and open no later round after uncertainty", async () => {
    const copiedKeys: string[] = [];
    const attempted: number[] = [];
    let earlierCommitted = 0n;
    const inputs = Array.from({ length: 260 }, (_, index) => ({
      organizationId: ids.orgB,
      objectKey: `fixture/copy-round-${index}`,
      sizeBytes: 1,
      copy: async () => {
        attempted.push(index);
        if (index === 150) {
          earlierCommitted =
            (
              await testDb
                .select()
                .from(organizationFileUsage)
                .where(eq(organizationFileUsage.organizationId, ids.orgB))
            ).at(0)?.committedBytes ?? 0n;
          return Result.err(new Error("uncertain copy timeout"));
        }
        copiedKeys.push(`fixture/copy-round-${index}`);
        return Result.ok(index);
      },
    }));
    const copied = await copyOrganizationFiles({
      inputs,
      concurrency: 16,
      db: db(),
    });
    expect(Result.isOk(copied)).toBe(true);
    expect(earlierCommitted).toBe(128n);
    expect(attempted).toHaveLength(256);
    expect(copiedKeys).toHaveLength(255);
    if (Result.isOk(copied)) {
      expect(copied.value).toHaveLength(260);
      expect(copied.value.filter(Result.isOk)).toHaveLength(255);
    }
    const usage = (
      await testDb
        .select()
        .from(organizationFileUsage)
        .where(eq(organizationFileUsage.organizationId, ids.orgB))
    ).at(0);
    expect(usage?.committedBytes).toBe(255n);
    expect(usage?.reservedBytes).toBe(1n);
    const pending = (
      await testDb
        .select()
        .from(organizationFileObjects)
        .where(eq(organizationFileObjects.objectKey, "fixture/copy-round-150"))
    ).at(0);
    expect(pending?.writeId).toBeTruthy();
    await removeOrganizationFilesBytes(copiedKeys, db());
    if (pending?.writeId) {
      await releaseOrganizationFileBytes(
        {
          status: "reserved",
          organizationId: ids.orgB,
          objectKey: pending.objectKey,
          writeId: pending.writeId,
        },
        db(),
      );
    }
  });

  test("batch commits settle matching siblings when one reservation is reclaimed", async () => {
    const reserved = await reserveOrganizationFilesBytes(
      [input("fixture/reclaimed-a", 7), input("fixture/reclaimed-b", 5)],
      db(),
    );
    expect(Result.isOk(reserved)).toBe(true);
    if (Result.isError(reserved)) {
      return;
    }
    const reclaimedId = Bun.randomUUIDv7();
    await testDb
      .update(organizationFileObjects)
      .set({ writeId: reclaimedId })
      .where(eq(organizationFileObjects.objectKey, "fixture/reclaimed-a"));
    const committed = await commitOrganizationFilesBytes(reserved.value, db());
    expect(committed).toMatchObject({
      value: { busyObjectKeys: ["fixture/reclaimed-a"] },
    });
    expect((await counter())?.committedBytes).toBe(5n);
    expect((await counter())?.reservedBytes).toBe(7n);
    await removeOrganizationFileBytes("fixture/reclaimed-b", db());
    await releaseOrganizationFileBytes(
      {
        status: "reserved",
        organizationId: ids.orgA,
        objectKey: "fixture/reclaimed-a",
        writeId: reclaimedId,
      },
      db(),
    );
  });

  test("batch reservation recovers confirmed stale writes and retries once", async () => {
    const fake = startFakeS3();
    const inputs = [
      input("fixture/batch-recover-a", 4),
      input("fixture/batch-recover-b", 5),
    ];
    try {
      const reserved = await reserveOrganizationFilesBytes(inputs, db());
      expect(Result.isOk(reserved)).toBe(true);
      fake.put(
        envBase.S3_BUCKET,
        "fixture/batch-recover-a",
        "four",
        undefined,
        new Date(),
      );
      fake.put(
        envBase.S3_BUCKET,
        "fixture/batch-recover-b",
        "fives",
        undefined,
        new Date(),
      );
      await testDb
        .update(organizationFileObjects)
        .set({ reservationStartedAt: new Date(Date.now() - 6 * 60_000) })
        .where(eq(organizationFileObjects.organizationId, ids.orgA));
      const recovered = await reserveOrganizationFilesBytes(inputs, db());
      expect(recovered).toMatchObject({
        value: [
          { status: "already_committed" },
          { status: "already_committed" },
        ],
      });
      expect((await counter())?.committedBytes).toBe(9n);
      expect((await counter())?.reservedBytes).toBe(0n);
      await removeOrganizationFilesBytes(
        inputs.map((item) => item.objectKey),
        db(),
      );
    } finally {
      fake.stop();
    }
  });

  test("busy and cross-organization batch aborts retain typed errors without reserving siblings", async () => {
    const held = await reserveOrganizationFileBytes(
      input("fixture/abort-held", 5),
      db(),
    );
    expect(Result.isOk(held)).toBe(true);
    if (Result.isError(held)) {
      return;
    }
    const busy = await reserveOrganizationFilesBytes(
      [input("fixture/abort-fresh", 3), input("fixture/abort-held", 5)],
      db(),
    );
    expect(busy).toMatchObject({ error: { reason: "reservation_busy" } });
    expect((await counter())?.reservedBytes).toBe(5n);
    const sibling = await testDb
      .select()
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.objectKey, "fixture/abort-fresh"));
    expect(sibling).toHaveLength(0);
    const conflict = await reserveOrganizationFilesBytes(
      [{ ...input("fixture/abort-held", 5), organizationId: ids.orgB }],
      db(),
    );
    expect(conflict).toMatchObject({ error: { reason: "key_conflict" } });
    expect((await counter())?.reservedBytes).toBe(5n);
    await releaseOrganizationFileBytes(held.value, db());
  });

  test("flag off does not call the database", async () => {
    env.FEATURE_FILE_USAGE_LIMITS = false;
    envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = false;
    const noDb = {
      transaction: async () => {
        throw new Error("unexpected transaction");
      },
    };
    const reservation = await reserveOrganizationFileBytes(
      input("fixture/off", 3),
      asTestRaw<
        NonNullable<Parameters<typeof reserveOrganizationFileBytes>[1]>
      >(noDb),
    );
    expect(reservation).toMatchObject({ value: { status: "disabled" } });
    env.FEATURE_FILE_USAGE_LIMITS = true;
    envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
  });
});
