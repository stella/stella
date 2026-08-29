import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entityVersions,
  fields,
  properties,
  reportExports,
} from "@/api/db/schema";
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
  calculations: [],
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
const fallbackPropertyId = toSafeId<"property">(Bun.randomUUIDv7());
const fallbackFieldId = toSafeId<"field">(Bun.randomUUIDv7());
const tombstonedVersionId = toSafeId<"entityVersion">(Bun.randomUUIDv7());
const tombstonedFieldId = toSafeId<"field">(Bun.randomUUIDv7());

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

  await testDb.insert(properties).values({
    id: fallbackPropertyId,
    workspaceId: ids.wsA1,
    name: "Report result file",
    status: "fresh",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
  });
  await testDb.insert(entityVersions).values({
    id: tombstonedVersionId,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    versionNumber: 2,
    deletedAt: new Date("2026-07-17T09:00:00.000Z"),
    deletedBy: ids.userA1,
  });
  await testDb.insert(fields).values([
    {
      id: fallbackFieldId,
      workspaceId: ids.wsA1,
      propertyId: fallbackPropertyId,
      entityVersionId: ids.entityVersionA1,
      content: {
        version: 1,
        type: "file",
        id: Bun.randomUUIDv7(),
        fileName: "historical-report.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 1024,
        encrypted: false,
        sha256Hex: "a".repeat(64),
        pdfFileId: null,
      },
    },
    {
      id: tombstonedFieldId,
      workspaceId: ids.wsA1,
      propertyId: fallbackPropertyId,
      entityVersionId: tombstonedVersionId,
      content: {
        version: 1,
        type: "file",
        id: Bun.randomUUIDv7(),
        fileName: "withdrawn-report.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 1024,
        encrypted: false,
        sha256Hex: "b".repeat(64),
        pdfFileId: null,
      },
    },
  ]);

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
      mode: index === 0 ? "download" : "workspace",
      requestedBy: ids.userA1,
      ...(index === 1 && {
        resultEntityId: ids.entityA1,
        resultFieldId: ids.fieldA1,
      }),
      ...(index === 2 && { resultEntityId: ids.entityA1 }),
      ...(index === 3 && {
        resultEntityId: ids.entityA1,
        resultFieldId: ids.fieldB1,
      }),
      ...(index === 4 && {
        resultEntityId: ids.entityA1,
        resultFieldId: tombstonedFieldId,
      }),
      resultS3Key:
        index === 0 ? `exports/${ids.orgA}/${ids.wsA1}/${exportId}.docx` : null,
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
    await testDb
      .delete(fields)
      .where(inArray(fields.id, [fallbackFieldId, tombstonedFieldId]));
    await testDb
      .delete(entityVersions)
      .where(eq(entityVersions.id, tombstonedVersionId));
    await testDb
      .delete(properties)
      .where(eq(properties.id, fallbackPropertyId));
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

  test("exposes download availability without returning the storage key", async () => {
    const result = await Result.gen(() =>
      readReportExportHistory({
        cursor: undefined,
        limit: 100,
        requestedBy: ids.userA1,
        safeDb,
        workspaceId: ids.wsA1,
      }),
    );

    if (Result.isError(result)) {
      throw result.error;
    }
    const downloadableExport = result.value.items.find(
      ({ id }) => id === requesterExports.at(0)?.id,
    );
    expect(downloadableExport?.downloadAvailable).toBe(true);
    expect(downloadableExport).not.toHaveProperty("resultS3Key");
    expect(
      result.value.items
        .filter(({ mode }) => mode === "workspace")
        .every(({ downloadAvailable }) => !downloadAvailable),
    ).toBe(true);
  });

  test("returns the persisted workspace result field for direct document links", async () => {
    const result = await Result.gen(() =>
      readReportExportHistory({
        cursor: undefined,
        limit: 100,
        requestedBy: ids.userA1,
        safeDb,
        workspaceId: ids.wsA1,
      }),
    );

    if (Result.isError(result)) {
      throw result.error;
    }
    const workspaceExport = result.value.items.find(
      ({ id }) => id === requesterExports.at(1)?.id,
    );
    expect(workspaceExport).toMatchObject({
      resultEntityId: ids.entityA1,
      resultFieldId: ids.fieldA1,
    });
  });

  test("resolves current file provenance for historical, invalid, and tombstoned receipts", async () => {
    const result = await Result.gen(() =>
      readReportExportHistory({
        cursor: undefined,
        limit: 100,
        requestedBy: ids.userA1,
        safeDb,
        workspaceId: ids.wsA1,
      }),
    );

    if (Result.isError(result)) {
      throw result.error;
    }
    const historicalExport = result.value.items.find(
      ({ id }) => id === requesterExports.at(2)?.id,
    );
    const foreignFieldExport = result.value.items.find(
      ({ id }) => id === requesterExports.at(3)?.id,
    );
    const tombstonedFieldExport = result.value.items.find(
      ({ id }) => id === requesterExports.at(4)?.id,
    );
    expect(historicalExport).toMatchObject({
      resultEntityId: ids.entityA1,
      resultFieldId: fallbackFieldId,
    });
    expect(foreignFieldExport).toMatchObject({
      resultEntityId: ids.entityA1,
      resultFieldId: fallbackFieldId,
    });
    expect(tombstonedFieldExport).toMatchObject({
      resultEntityId: ids.entityA1,
      resultFieldId: fallbackFieldId,
    });
  });
});

const seedExport = async ({
  exportId,
  mode = "workspace",
  requestedBy,
  resultEntityId = null,
  resultFieldId = null,
  resultS3Key = null,
  timestamp,
  workspaceId,
}: {
  exportId: SafeId<"reportExport">;
  mode?: "download" | "workspace";
  requestedBy: SafeId<"user">;
  resultEntityId?: SafeId<"entity"> | null;
  resultFieldId?: SafeId<"field"> | null;
  resultS3Key?: string | null;
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
      result_entity_id,
      result_field_id,
      result_s3_key,
      created_at,
      updated_at
    ) values (
      ${exportId},
      ${workspaceId},
      ${requestedBy},
      ${JSON.stringify({ type: "builtin", key: "dd-report" })}::text::jsonb,
      ${JSON.stringify(tableLayout)}::text::jsonb,
      'completed',
      ${mode},
      ${resultEntityId},
      ${resultFieldId},
      ${resultS3Key},
      ${timestamp}::timestamptz,
      ${timestamp}::timestamptz
    )
  `);
};
