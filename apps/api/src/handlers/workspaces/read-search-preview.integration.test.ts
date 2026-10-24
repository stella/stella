import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readSearchPreviewHandler } from "./read-search-preview.query";

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;
const seededIds: ReturnType<typeof createSafeId<"entity">>[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
});

afterEach(async () => {
  if (seededIds.length === 0) {
    return;
  }
  // A seeded entity points at its current version, so detach it first.
  await testDb
    .update(entities)
    .set({ currentVersionId: null })
    .where(inArray(entities.id, seededIds));
  const seededVersionIds = testDb
    .select({ id: entityVersions.id })
    .from(entityVersions)
    .where(inArray(entityVersions.entityId, seededIds));
  await testDb
    .delete(fields)
    .where(inArray(fields.entityVersionId, seededVersionIds));
  await testDb
    .delete(entityVersions)
    .where(inArray(entityVersions.entityId, seededIds));
  await testDb.delete(entities).where(inArray(entities.id, seededIds));
  seededIds.length = 0;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const entityId = () => {
  const id = createSafeId<"entity">();
  seededIds.push(id);
  return id;
};

describe("matter search preview", () => {
  test("returns bounded independent highlights without leaking another matter", async () => {
    const firstTaskId = entityId();
    const secondTaskId = entityId();
    const thirdTaskId = entityId();
    const omittedTaskId = entityId();
    const completedTaskId = entityId();
    const overdueTaskIds = [entityId(), entityId(), entityId()];
    // Dated before every task: they would lead the agenda if not filtered.
    const referenceItems = [
      { id: entityId(), listItemType: "fact" as const },
      { id: entityId(), listItemType: "event" as const },
    ];
    const recentDocumentId = entityId();
    const olderDocumentId = entityId();
    const legacyDocumentId = entityId();
    const otherMatterTaskId = entityId();
    const otherMatterDocumentId = entityId();

    await testDb.insert(entities).values([
      {
        id: firstTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview first deadline",
        dueDate: "2999-01-01",
        status: "open",
      },
      {
        id: secondTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview second deadline",
        dueDate: "2999-01-02",
        status: null,
      },
      {
        id: thirdTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview third deadline",
        dueDate: "2999-01-03",
        status: "in_progress",
      },
      {
        id: omittedTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview fourth deadline",
        dueDate: "2999-01-04",
        status: "open",
      },
      {
        id: completedTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview completed deadline",
        dueDate: "2998-01-01",
        status: "done",
      },
      ...referenceItems.map(({ id, listItemType }) => ({
        id,
        workspaceId: ids.wsA1,
        kind: "task" as const,
        listItemType,
        name: `Dated ${listItemType} list item`,
        dueDate: "2998-06-01",
        status: "open",
      })),
      ...overdueTaskIds.map((id, index) => ({
        id,
        workspaceId: ids.wsA1,
        kind: "task" as const,
        name: `Overdue deadline ${index + 1}`,
        dueDate: `1900-01-0${index + 1}`,
        status: "open",
      })),
      {
        id: legacyDocumentId,
        workspaceId: ids.wsA1,
        kind: "document",
        name: "Preview document without edit timestamp",
        createdAt: new Date("2999-01-03T00:00:00.000Z"),
        updatedAt: null,
      },
      {
        id: recentDocumentId,
        workspaceId: ids.wsA1,
        kind: "document",
        name: "Preview latest document",
        updatedAt: new Date("2999-01-02T00:00:00.000Z"),
      },
      {
        id: olderDocumentId,
        workspaceId: ids.wsA1,
        kind: "document",
        name: "Preview older document",
        updatedAt: new Date("2999-01-01T00:00:00.000Z"),
      },
      {
        id: otherMatterTaskId,
        workspaceId: ids.wsB1,
        kind: "task",
        name: "Other matter deadline",
        dueDate: "2998-01-01",
        status: "open",
      },
      {
        id: otherMatterDocumentId,
        workspaceId: ids.wsB1,
        kind: "document",
        name: "Other matter document",
        updatedAt: new Date("3000-01-01T00:00:00.000Z"),
      },
    ]);
    const recentVersionId = createSafeId<"entityVersion">();
    await testDb.insert(entityVersions).values({
      id: recentVersionId,
      workspaceId: ids.wsA1,
      entityId: recentDocumentId,
    });
    await testDb.insert(fields).values({
      id: createSafeId<"field">(),
      workspaceId: ids.wsA1,
      propertyId: ids.filePropertyA1,
      entityVersionId: recentVersionId,
      content: {
        version: 1,
        type: "file",
        id: Bun.randomUUIDv7(),
        fileName: "Preview latest document.docx",
        mimeType: DOCX_MIME_TYPE,
        sizeBytes: 2048,
        encrypted: false,
        sha256Hex: "b".repeat(64),
        pdfFileId: null,
      },
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: recentVersionId })
      .where(eq(entities.id, recentDocumentId));

    const result = await readSearchPreviewHandler({
      scopedDb,
      workspaceId: ids.wsA1,
    });

    expect(result.upcomingAgenda).toHaveLength(
      LIMITS.matterSearchPreviewAgendaItems,
    );
    expect(result.upcomingAgenda.map(({ id }) => id)).toEqual([
      firstTaskId,
      secondTaskId,
      thirdTaskId,
    ]);
    expect(result.recentDocuments).toEqual([
      {
        id: legacyDocumentId,
        name: "Preview document without edit timestamp",
        mimeType: null,
        updatedAt: "2999-01-03T00:00:00.000Z",
      },
      {
        id: recentDocumentId,
        name: "Preview latest document",
        mimeType: DOCX_MIME_TYPE,
        updatedAt: "2999-01-02T00:00:00.000Z",
      },
      {
        id: olderDocumentId,
        name: "Preview older document",
        mimeType: null,
        updatedAt: "2999-01-01T00:00:00.000Z",
      },
    ]);
    expect(
      result.upcomingAgenda.some(({ id }) => id === otherMatterTaskId),
    ).toBe(false);
    expect(
      result.upcomingAgenda.some(({ id }) => overdueTaskIds.includes(id)),
    ).toBe(false);
    expect(
      result.upcomingAgenda.some(({ id }) =>
        referenceItems.some((item) => item.id === id),
      ),
    ).toBe(false);
    expect(
      result.recentDocuments.some(({ id }) => id === otherMatterDocumentId),
    ).toBe(false);
  });
});
