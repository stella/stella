import { Result } from "better-result";
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
import { createSafeId } from "@/api/lib/branded-types";
import {
  commitOrganizationFileBytes,
  copyOrganizationFile,
  reconcileOrganizationFileObject,
  releaseOrganizationFileBytes,
  removeOrganizationFileBytes,
  reserveOrganizationFileBytes,
  writeOrganizationFile,
} from "@/api/lib/files/organization-file-usage";
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
});

afterAll(async () => {
  env.FEATURE_FILE_USAGE_LIMITS = priorFlag;
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

  test("capacity reduction preserves bytes and rejects later durable writes", async () => {
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
      ...input("fixture/commit-failure", 9),
      db: { transaction: failingTransaction },
      write: async () => "confirmed",
    });
    expect(Result.isError(written)).toBe(true);
    const object = await testDb
      .select({ writeId: organizationFileObjects.writeId })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.objectKey, "fixture/commit-failure"))
      .then((rows) => rows.at(0));
    expect(object?.writeId).toBeTruthy();
    expect((await counter())?.reservedBytes).toBe(9n);
    await removeOrganizationFileBytes("fixture/commit-failure", db());
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

  test("flag off does not call the database", async () => {
    env.FEATURE_FILE_USAGE_LIMITS = false;
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
  });
});
