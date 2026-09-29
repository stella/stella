import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import { reconcileOrganizationFileObject } from "@/api/lib/files/organization-file-usage";
import {
  isTemporaryOrganizationObjectKey,
  reconcileAbsentOrganizationFileObjects,
  reportOrganizationFileUsageBackfill,
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
    expect(checked.filter((key) => key === absentKey)).toHaveLength(2);
    expect(checked.filter((key) => key === presentKey)).toHaveLength(2);
    expect(checked).not.toContain(temporaryKey);
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

  test("preserves a committed object written after the first absence check", async () => {
    const objectKey = `${ids.orgA}/workspace_1/files/written-during-backfill`;
    expect(
      Result.isOk(
        await reconcileOrganizationFileObject(
          { organizationId: ids.orgA, objectKey, sizeBytes: 3 },
          ledgerDb(),
        ),
      ),
    ).toBe(true);
    let checks = 0;
    const removed = await reconcileAbsentOrganizationFileObjects({
      db: ledgerDb(),
      organizationId: ids.orgA,
      objectExists: async (key) => {
        if (key !== objectKey) {
          return true;
        }
        checks += 1;
        if (checks === 1) {
          const written = await reconcileOrganizationFileObject(
            { organizationId: ids.orgA, objectKey, sizeBytes: 8 },
            ledgerDb(),
          );
          expect(Result.isOk(written)).toBe(true);
          return false;
        }
        return true;
      },
      staleBefore: new Date("2026-01-01T00:00:00Z"),
    });
    expect(removed).toBe(0);
    expect(checks).toBe(2);
    const object = await testDb
      .select({ sizeBytes: organizationFileObjects.sizeBytes })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.objectKey, objectKey))
      .then((matches) => matches.at(0));
    expect(object?.sizeBytes).toBe(8n);
    const counter = await testDb
      .select({ committedBytes: organizationFileUsage.committedBytes })
      .from(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, ids.orgA))
      .then((matches) => matches.at(0));
    expect(counter?.committedBytes).toBe(11n);
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

  test("prints the summary while mismatched reservations stay pending", async () => {
    await testDb
      .delete(organizationFileObjects)
      .where(
        inArray(organizationFileObjects.organizationId, [ids.orgA, ids.orgB]),
      );
    const old = new Date("2025-12-01T00:00:00Z");
    await testDb.insert(organizationFileObjects).values(
      ["first", "second"].map((name) => ({
        organizationId: ids.orgA,
        objectKey: `${ids.orgA}/workspace_1/files/mismatched-${name}`,
        sizeBytes: 3n,
        status: "reserved" as const,
        writeId: `mismatched-${name}`,
        reservationStartedAt: old,
      })),
    );
    const lines: string[] = [];
    const counts = {
      imported: 4,
      removed: 1,
      settledReservations: 5,
      mismatchedReservations: 2,
    };

    const unexpected = await reportOrganizationFileUsageBackfill({
      counts,
      db: ledgerDb(),
      log: (line) => {
        lines.push(line);
      },
    });

    expect(unexpected).toBe(0);
    expect(lines).toEqual([
      "Reconciled 4 stored objects; removed 1 absent ledger rows; settled 5 reservations; 2 mismatched reservations remain pending; 2 unsettled writes remain.",
    ]);

    // A pending write the reconciler did not account for still blocks
    // enablement, but only after the summary has been printed.
    const blocked = await reportOrganizationFileUsageBackfill({
      counts: { ...counts, mismatchedReservations: 1 },
      db: ledgerDb(),
      log: (line) => {
        lines.push(line);
      },
    });
    expect(blocked).toBe(1);
    expect(lines).toHaveLength(2);
  });

  test("deleting a full page preserves the next keyset page and converges", async () => {
    const objects = Array.from({ length: 206 }, (_, index) => ({
      organizationId: ids.orgB,
      objectKey: `${ids.orgB}/page-boundary/${String(index).padStart(3, "0")}`,
      sizeBytes: 1n,
      status: "committed" as const,
    }));
    await testDb.insert(organizationFileObjects).values(objects);
    await testDb
      .update(organizationFileUsage)
      .set({ committedBytes: 206n, reservedBytes: 0n })
      .where(eq(organizationFileUsage.organizationId, ids.orgB));
    const options = {
      db: ledgerDb(),
      organizationId: ids.orgB,
      objectExists: async (key: string) => Number(key.split("/").at(-1)) >= 200,
      staleBefore: new Date("2026-01-01T00:00:00Z"),
    };
    expect(await reconcileAbsentOrganizationFileObjects(options)).toBe(200);
    expect(await reconcileAbsentOrganizationFileObjects(options)).toBe(0);
    const remaining = await testDb
      .select({ objectKey: organizationFileObjects.objectKey })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.organizationId, ids.orgB))
      .orderBy(asc(organizationFileObjects.objectKey));
    expect(remaining.map(({ objectKey }) => objectKey)).toEqual(
      objects.slice(200).map(({ objectKey }) => objectKey),
    );
    const counter = await testDb
      .select({ committedBytes: organizationFileUsage.committedBytes })
      .from(organizationFileUsage)
      .where(eq(organizationFileUsage.organizationId, ids.orgB))
      .then((rows) => rows.at(0));
    expect(counter?.committedBytes).toBe(6n);
  });
});
