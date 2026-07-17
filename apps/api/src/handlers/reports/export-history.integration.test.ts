import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { reportExports } from "@/api/db/schema";
import type { ViewLayout } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { readReportExportHistory } from "@/api/handlers/reports/export-history";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

const tableLayout: Extract<ViewLayout, { type: "table" }> = {
  type: "table",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  columnOrder: [],
  columnPinning: [],
};

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededExportIds: SafeId<"reportExport">[] = [];
const requesterExports: {
  id: SafeId<"reportExport">;
  timestamp: string;
}[] = [];

const readRequesterExportPage = async (cursor: string | undefined) =>
  await Result.gen(() =>
    readReportExportHistory({
      cursor,
      limit: 2,
      requestedBy: ids.userA1,
      safeDb,
      workspaceId: ids.wsA1,
    }),
  );

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  safeDb = toSafeDbMock(asTestRaw<ScopedDb>(scoped));

  for (let index = 0; index < 7; index++) {
    const exportId = toSafeId<"reportExport">(Bun.randomUUIDv7());
    const timestamp = `2026-07-17T10:00:00.123${Math.floor(index / 2)
      .toString()
      .padStart(3, "0")}`;
    requesterExports.push({ id: exportId, timestamp });
    seededExportIds.push(exportId);
    // oxlint-disable-next-line no-await-in-loop -- deterministic timestamp ties exercise the id cursor boundary
    await seedExport({
      exportId,
      requestedBy: ids.userA1,
      timestamp,
      workspaceId: ids.wsA1,
    });
  }

  const otherRequesterId = toSafeId<"reportExport">(Bun.randomUUIDv7());
  const otherWorkspaceId = toSafeId<"reportExport">(Bun.randomUUIDv7());
  seededExportIds.push(otherRequesterId, otherWorkspaceId);
  await seedExport({
    exportId: otherRequesterId,
    requestedBy: ids.userA2,
    timestamp: "2026-07-17T10:00:01.000000",
    workspaceId: ids.wsA1,
  });
  await seedExport({
    exportId: otherWorkspaceId,
    requestedBy: ids.userA1,
    timestamp: "2026-07-17T10:00:02.000000",
    workspaceId: ids.wsA2,
  });
});

afterAll(async () => {
  try {
    if (seededExportIds.length > 0) {
      await testDb
        .delete(reportExports)
        .where(inArray(reportExports.id, seededExportIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("report export history", () => {
  test("returns every requester receipt exactly once across cursor pages", async () => {
    const collectedIds: string[] = [];
    let cursor: string | undefined;

    for (let pageNumber = 0; pageNumber < 7; pageNumber++) {
      // oxlint-disable-next-line no-await-in-loop -- each cursor comes from the preceding page
      const result = await readRequesterExportPage(cursor);
      if (Result.isError(result)) {
        throw result.error;
      }

      collectedIds.push(...result.value.items.map(({ id }) => id));
      cursor = result.value.nextCursor ?? undefined;
      if (cursor === undefined) {
        break;
      }
    }

    const expectedIds = requesterExports
      .toSorted((left, right) => {
        if (left.timestamp !== right.timestamp) {
          return left.timestamp < right.timestamp ? 1 : -1;
        }
        if (left.id === right.id) {
          return 0;
        }
        return left.id < right.id ? 1 : -1;
      })
      .map(({ id }) => id);
    expect(collectedIds).toEqual(expectedIds);
    expect(new Set(collectedIds).size).toBe(requesterExports.length);
  });

  test("rejects a malformed opaque cursor", async () => {
    const result = await Result.gen(() =>
      readReportExportHistory({
        cursor: "not-a-cursor",
        limit: 2,
        requestedBy: ids.userA1,
        safeDb,
        workspaceId: ids.wsA1,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 400 });
    }
  });
});

const seedExport = async ({
  exportId,
  requestedBy,
  timestamp,
  workspaceId,
}: {
  exportId: SafeId<"reportExport">;
  requestedBy: SafeId<"user">;
  timestamp: string;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  await testDb.execute(sql`
    insert into report_exports (
      id,
      workspace_id,
      requested_by,
      template_ref,
      layout,
      status,
      mode,
      created_at,
      updated_at
    ) values (
      ${exportId},
      ${workspaceId},
      ${requestedBy},
      ${JSON.stringify({ type: "builtin", key: "dd-report" })}::jsonb,
      ${JSON.stringify(tableLayout)}::jsonb,
      'completed',
      'workspace',
      ${timestamp}::timestamp,
      ${timestamp}::timestamp
    )
  `);
};
