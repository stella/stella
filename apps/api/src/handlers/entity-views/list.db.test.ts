import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import type { SafeDb } from "@/api/db/safe-db";
import { entityViews } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ViewLayout } from "@/api/lib/views-schema";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listViews from "./list";

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
      return expect.unreachable("Expected the entity view list");
    }
    expect(result.items.map((view) => view.name)).toEqual(["A private"]);
  });
});
