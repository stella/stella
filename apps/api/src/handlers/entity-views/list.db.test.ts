import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import type { SafeDb } from "@/api/db/safe-db";
import { entityViews } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ViewLayout } from "@/api/lib/views-schema";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listViews from "./list";
import reorderViews from "./reorder";
import updateView from "./update";

let testDb: TestDatabase;
let ids: TestIds;
const insertedIds: SafeId<"workspaceView">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await testDb.delete(entityViews).where(inArray(entityViews.id, insertedIds));
  await releaseRlsFixture();
});

const layout = {
  version: 1,
  type: "kanban",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
} as const satisfies ViewLayout;

const contextFor = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) =>
  createTestHandlerContext<Parameters<typeof listViews.handler>[0]>({
    audit: NO_AUDIT,
    scopedDb: NO_DB,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    safeDb: asTestRaw<SafeDb>(createSafeDb(testDb, [], organizationId, userId)),
  });

describe("entity view owner isolation", () => {
  test("lists only the authenticated user's views within the active organization", async () => {
    const rows = [
      {
        id: toSafeId<"workspaceView">(Bun.randomUUIDv7()),
        organizationId: ids.orgA,
        userId: ids.userA1,
        name: "A private",
        layout,
        position: 0,
      },
      {
        id: toSafeId<"workspaceView">(Bun.randomUUIDv7()),
        organizationId: ids.orgA,
        userId: ids.userA2,
        name: "A colleague",
        layout,
        position: 0,
      },
      {
        id: toSafeId<"workspaceView">(Bun.randomUUIDv7()),
        organizationId: ids.orgB,
        userId: ids.userB1,
        name: "Other org",
        layout,
        position: 0,
      },
    ];
    insertedIds.push(...rows.map((row) => row.id));
    await testDb.insert(entityViews).values(rows);

    const result = await listViews.handler(contextFor(ids.orgA, ids.userA1));
    expect(result).not.toBeInstanceOf(ElysiaCustomStatusResponse);
    if (result instanceof ElysiaCustomStatusResponse) {
      panic("Expected the entity view list");
    }
    expect(result.items.map((view) => view.name)).toEqual(["A private"]);
  });

  test("update rejects a stale row revision with VERSION_CONFLICT", async () => {
    const id = toSafeId<"workspaceView">(Bun.randomUUIDv7());
    insertedIds.push(id);
    await testDb.insert(entityViews).values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      name: "Stale update",
      layout,
      position: 1,
    });
    const result = await updateView.handler(
      createTestHandlerContext<Parameters<typeof updateView.handler>[0]>({
        audit: NO_AUDIT,
        scopedDb: NO_DB,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [], ids.orgA, ids.userA1),
        ),
        params: { viewId: id },
        body: {
          name: "Rejected rename",
          expectedUpdatedAt: new Date(0).toISOString(),
        },
      }),
    );

    expect(result).toMatchObject({
      code: 409,
      response: { code: "version_conflict" },
    });
  });

  test("reorder rejects a stale collection revision with VERSION_CONFLICT", async () => {
    const owned = await testDb.query.entityViews.findMany({
      where: {
        organizationId: { eq: ids.orgA },
        userId: { eq: ids.userA1 },
      },
    });
    const result = await reorderViews.handler(
      createTestHandlerContext<Parameters<typeof reorderViews.handler>[0]>({
        audit: NO_AUDIT,
        scopedDb: NO_DB,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(testDb, [], ids.orgA, ids.userA1),
        ),
        body: {
          viewIds: owned.map((view) => view.id),
          expectedUpdatedAt: new Date(0).toISOString(),
        },
      }),
    );

    expect(result).toMatchObject({
      code: 409,
      response: { code: "version_conflict" },
    });
  });
});
