import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";

import { auditLogs, savedSearches } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { AUDIT_ACTION, createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SavedSearchCriteria } from "@/api/lib/saved-searches";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import getSavedSearch from "./get";
import { updateSavedSearchBodySchema } from "./schema";
import updateSavedSearch from "./update";

let testDb: TestDatabase;
let ids: TestIds;
const seededIds: ReturnType<typeof createSafeId<"savedSearch">>[] = [];
const criteria = {
  version: 1,
  query: "motion",
  workspaceIds: [],
  types: ["document"],
  kinds: [],
  editedByUserIds: [],
  mimeTypes: [],
  sort: "relevance",
} satisfies SavedSearchCriteria;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});
afterAll(async () => {
  if (seededIds.length > 0) {
    await testDb
      .delete(savedSearches)
      .where(inArray(savedSearches.id, seededIds));
  }
  await releaseRlsFixture();
});

const seed = async (updatedAt = new Date("2099-01-01T00:00:00.000Z")) => {
  const id = createSafeId<"savedSearch">();
  seededIds.push(id);
  const rows = await testDb
    .insert(savedSearches)
    .values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      name: "Original search",
      criteria,
      updatedAt,
    })
    .returning();
  return rows.at(0) ?? panic("Saved search fixture was not inserted");
};
const recorder = () =>
  createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: null,
    userId: ids.userA1,
    request: new Request("https://example.test/v1/saved-searches"),
    server: null,
  });
const readRow = async (id: typeof savedSearches.$inferSelect.id) =>
  (
    await testDb.select().from(savedSearches).where(eq(savedSearches.id, id))
  ).at(0) ?? panic("Saved search fixture disappeared");
const audits = async (id: typeof savedSearches.$inferSelect.id) =>
  await testDb.select().from(auditLogs).where(eq(auditLogs.resourceId, id));
const update = async (
  row: typeof savedSearches.$inferSelect,
  body: v.InferOutput<typeof updateSavedSearchBodySchema>,
  audit: AuditRecorder = recorder(),
) =>
  await updateSavedSearch.handler(
    createTestHandlerContext<Parameters<typeof updateSavedSearch.handler>[0]>({
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      params: { savedSearchId: row.id },
      body,
      safeDb: createSafeDb(testDb, [], ids.orgA, ids.userA1),
      scopedDb: NO_DB,
      audit,
    }),
  );

test("requires a valid editor token without requiring either optional change", () => {
  expect(
    v.safeParse(updateSavedSearchBodySchema, { name: "Renamed" }).success,
  ).toBe(false);
  expect(
    v.safeParse(updateSavedSearchBodySchema, {
      name: "Renamed",
      expectedUpdatedAt: "invalid",
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(updateSavedSearchBodySchema, {
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    }).success,
  ).toBe(true);
});

test("renames without replacing criteria and advances the visible token by one millisecond", async () => {
  const row = await seed();
  const answer = await update(row, {
    name: "Renamed search",
    expectedUpdatedAt: row.updatedAt.toISOString(),
  });
  const stored = await readRow(row.id);
  expect(answer).toMatchObject({
    id: row.id,
    name: "Renamed search",
    updatedAt: stored.updatedAt.toISOString(),
  });
  expect(stored.criteria).toEqual(criteria);
  expect(stored.updatedAt.getTime()).toBe(row.updatedAt.getTime() + 1);
  expect(await audits(row.id)).toMatchObject([
    {
      action: AUDIT_ACTION.UPDATE,
      changes: { fields: { old: null, new: ["name"] } },
    },
  ]);
});

test("rejects replay of the old token without changing data or adding an audit", async () => {
  const row = await seed();
  const token = row.updatedAt.toISOString();
  await update(row, { name: "First writer", expectedUpdatedAt: token });
  const before = await readRow(row.id);
  const beforeAudits = await audits(row.id);
  const answer = await update(row, {
    name: "Stale writer",
    criteria: { ...criteria, query: "appeal" },
    expectedUpdatedAt: token,
  });
  expect(answer).toMatchObject({
    code: 409,
    response: { code: API_VERSION_CONFLICT_ERROR_CODE },
  });
  expect(await readRow(row.id)).toEqual(before);
  expect(await audits(row.id)).toEqual(beforeAudits);
});

test("replaces criteria without changing the name and preserves audit field order", async () => {
  const row = await seed();
  const nextCriteria = { ...criteria, query: "appeal" };
  expect(
    await update(row, {
      criteria: nextCriteria,
      expectedUpdatedAt: row.updatedAt.toISOString(),
    }),
  ).toMatchObject({ name: row.name, criteria: nextCriteria });
  const stored = await readRow(row.id);
  await update(stored, {
    name: "Both fields",
    criteria,
    expectedUpdatedAt: stored.updatedAt.toISOString(),
  });
  const recorded = await audits(row.id);
  expect(recorded).toHaveLength(2);
  expect(recorded).toContainEqual(
    expect.objectContaining({
      changes: { fields: { old: null, new: ["criteria"] } },
    }),
  );
  expect(recorded).toContainEqual(
    expect.objectContaining({
      changes: { fields: { old: null, new: ["name", "criteria"] } },
    }),
  );
});

test("rolls the rename, token and recorded audit back when their transaction aborts", async () => {
  const row = await seed();
  const realRecorder = recorder();
  let reachedRollback = false;
  const answer = await update(
    row,
    { name: "Must roll back", expectedUpdatedAt: row.updatedAt.toISOString() },
    async (tx, event) => {
      await realRecorder(tx, event);
      reachedRollback = true;
      tx.rollback();
    },
  );
  expect(reachedRollback).toBe(true);
  expect(answer).toMatchObject({ code: 500 });
  expect(await readRow(row.id)).toEqual(row);
  expect(await audits(row.id)).toEqual([]);
});

test.each(["owner", "other member", "other organization", "missing"] as const)(
  "keeps exact reads and edits scoped to their owner (%s)",
  async (actor) => {
    const row = await seed();
    const principals = {
      owner: { organizationId: ids.orgA, userId: ids.userA1 },
      "other member": { organizationId: ids.orgA, userId: ids.userA2 },
      "other organization": { organizationId: ids.orgB, userId: ids.userB1 },
      missing: { organizationId: ids.orgA, userId: ids.userA1 },
    };
    const { organizationId, userId } = principals[actor];
    const savedSearchId =
      actor === "missing" ? createSafeId<"savedSearch">() : row.id;
    const context = {
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      params: { savedSearchId },
      safeDb: createSafeDb(testDb, [], organizationId, userId),
      scopedDb: NO_DB,
      audit: NO_AUDIT,
    };
    const answer = await getSavedSearch.handler(
      createTestHandlerContext<Parameters<typeof getSavedSearch.handler>[0]>(
        context,
      ),
    );
    expect(answer).toMatchObject(
      actor === "owner"
        ? { id: row.id, name: row.name, updatedAt: row.updatedAt.toISOString() }
        : { code: 404 },
    );
    if (actor !== "owner") {
      const refused = await updateSavedSearch.handler(
        createTestHandlerContext<
          Parameters<typeof updateSavedSearch.handler>[0]
        >({
          ...context,
          body: {
            name: "Must remain unchanged",
            expectedUpdatedAt: row.updatedAt.toISOString(),
          },
        }),
      );
      expect(refused).toMatchObject({ code: 404 });
      expect(await readRow(row.id)).toEqual(row);
      expect(await audits(row.id)).toEqual([]);
    }
  },
);
