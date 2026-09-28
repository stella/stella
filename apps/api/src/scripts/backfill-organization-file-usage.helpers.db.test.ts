import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";

import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import { reconcileOrganizationFileObject } from "@/api/lib/files/organization-file-usage";
import {
  isTemporaryOrganizationObjectKey,
  reconcileAbsentOrganizationFileObjects,
} from "@/api/scripts/backfill-organization-file-usage.helpers";
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

const ledgerDb = () =>
  asTestRaw<NonNullable<Parameters<typeof reconcileOrganizationFileObject>[1]>>(
    testDb,
  );

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await testDb
    .delete(organizationFileObjects)
    .where(eq(organizationFileObjects.organizationId, ids.orgA));
  await testDb
    .delete(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, ids.orgA));
  await testDb
    .delete(organizationFileObjects)
    .where(eq(organizationFileObjects.organizationId, ids.orgB));
  await testDb
    .delete(organizationFileUsage)
    .where(eq(organizationFileUsage.organizationId, ids.orgB));
  await releaseTestDb();
});

describe("organization file usage backfill", () => {
  test("excludes temporary keys at both organization and workspace scopes", () => {
    const prefix = ids.orgA;
    const temporary = [
      "tmp/upload_1",
      `${prefix}/tmp/comparisons/upload_1`,
      `${prefix}/workspace_1/tmp/upload_1`,
      `${prefix}/workspace_1/tmp/upload_1/part`,
      `${prefix}/contact-extractions/tmp/upload_1`,
    ];
    const durable = [
      `${prefix}/workspace_1/files/file_1`,
      `${prefix}/workspace_1/ocr/run.pdf`,
      `${prefix}/workspace_1/tmp-file/file_1`,
    ];
    for (const key of temporary) {
      expect(isTemporaryOrganizationObjectKey(ids.orgA, key)).toBe(true);
    }
    for (const key of durable) {
      expect(isTemporaryOrganizationObjectKey(ids.orgA, key)).toBe(false);
    }
  });

  test("removes confirmed absent and temporary rows, then reaches a fixed point", async () => {
    const presentKey = `${ids.orgA}/workspace_1/files/present`;
    const absentKey = `${ids.orgA}/workspace_1/files/absent`;
    const temporaryKey = `${ids.orgA}/workspace_1/tmp/upload_1`;
    for (const [objectKey, sizeBytes] of [
      [presentKey, 3],
      [absentKey, 5],
      [temporaryKey, 7],
    ] as const) {
      expect(
        Result.isOk(
          await reconcileOrganizationFileObject(
            { organizationId: ids.orgA, objectKey, sizeBytes },
            ledgerDb(),
          ),
        ),
      ).toBe(true);
    }
    const checked: string[] = [];
    const options = {
      db: ledgerDb(),
      organizationId: ids.orgA,
      objectExists: async (key: string) => {
        checked.push(key);
        return key === presentKey;
      },
      staleBefore: new Date("2026-01-01T00:00:00Z"),
    };
    expect(await reconcileAbsentOrganizationFileObjects(options)).toBe(2);
    expect(await reconcileAbsentOrganizationFileObjects(options)).toBe(0);
    expect(checked).toEqual([absentKey, presentKey, presentKey]);
    const rows = await testDb
      .select({ objectKey: organizationFileObjects.objectKey })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.organizationId, ids.orgA));
    expect(rows.map((row) => row.objectKey)).toEqual([presentKey]);
    const usage = await testDb
      .select({ committedBytes: organizationFileUsage.committedBytes })
      .from(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, ids.orgA))
      .then((matches) => matches.at(0));
    expect(usage?.committedBytes).toBe(3n);
  });

  test("releases only old missing reservations and preserves pending present objects", async () => {
    const prefix = `${ids.orgB}/workspace_1/files`;
    const missingReserved = `${prefix}/missing-reserved`;
    const missingPending = `${prefix}/missing-pending`;
    const presentPending = `${prefix}/present-pending`;
    const recentReserved = `${prefix}/recent-reserved`;
    const old = new Date("2025-12-01T00:00:00Z");
    const recent = new Date("2026-01-02T00:00:00Z");
    await testDb.insert(organizationFileUsage).values({
      organizationId: ids.orgB,
      committedBytes: 15n,
      reservedBytes: 25n,
    });
    await testDb.insert(organizationFileObjects).values([
      {
        organizationId: ids.orgB,
        objectKey: missingReserved,
        sizeBytes: 11n,
        status: "reserved",
        writeId: "old-reserved",
        reservationStartedAt: old,
      },
      {
        organizationId: ids.orgB,
        objectKey: missingPending,
        sizeBytes: 13n,
        pendingSizeBytes: 20n,
        status: "committed",
        writeId: "old-pending",
        reservationStartedAt: old,
      },
      {
        organizationId: ids.orgB,
        objectKey: presentPending,
        sizeBytes: 2n,
        pendingSizeBytes: 4n,
        status: "committed",
        writeId: "present-pending",
        reservationStartedAt: old,
      },
      {
        organizationId: ids.orgB,
        objectKey: recentReserved,
        sizeBytes: 5n,
        status: "reserved",
        writeId: "recent-reserved",
        reservationStartedAt: recent,
      },
    ]);
    const options = {
      db: ledgerDb(),
      organizationId: ids.orgB,
      objectExists: async (key: string) => key === presentPending,
      staleBefore: new Date("2026-01-01T00:00:00Z"),
    };
    expect(await reconcileAbsentOrganizationFileObjects(options)).toBe(0);
    expect(await reconcileAbsentOrganizationFileObjects(options)).toBe(1);
    expect(await reconcileAbsentOrganizationFileObjects(options)).toBe(0);
    const rows = await testDb
      .select({
        objectKey: organizationFileObjects.objectKey,
        writeId: organizationFileObjects.writeId,
      })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.organizationId, ids.orgB))
      .orderBy(asc(organizationFileObjects.objectKey));
    expect(rows).toEqual([
      { objectKey: presentPending, writeId: "present-pending" },
      { objectKey: recentReserved, writeId: "recent-reserved" },
    ]);
    const usage = await testDb
      .select({
        committedBytes: organizationFileUsage.committedBytes,
        reservedBytes: organizationFileUsage.reservedBytes,
      })
      .from(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, ids.orgB))
      .then((matches) => matches.at(0));
    expect(usage).toMatchObject({ committedBytes: 2n, reservedBytes: 7n });
  });
});
