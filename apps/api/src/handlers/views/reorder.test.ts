import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import { workspaces, workspaceViews } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { createFeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { ViewLayout } from "@/api/lib/views-schema";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createView from "./create";
import deleteView from "./delete";
import listViews from "./list";
import reorderViews from "./reorder";
import updateView from "./update";

setDefaultTimeout(120_000);

// Pins the reorder handler's single-UPDATE CASE expression against a real
// Postgres (pglite): each CASE branch binds an untyped integer parameter,
// and without an explicit `::integer` cast Postgres rejects the assignment
// to the integer `position` column ("column is of type integer but
// expression is of type text"). No test exercised this write path before,
// which is how that broken UPDATE shipped.

type ReorderCtx = Parameters<typeof reorderViews.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

const seededViewIds: SafeId<"workspaceView">[] = [];

const emptyLayout: ViewLayout = {
  type: "filesystem",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
};

const seedView = async (
  name: string,
  position: number,
): Promise<SafeId<"workspaceView">> => {
  const id = createSafeId<"workspaceView">();
  seededViewIds.push(id);
  await testDb.insert(workspaceViews).values({
    id,
    workspaceId: ids.wsA1,
    name,
    layout: emptyLayout,
    position,
  });
  return id;
};

const runReorder = async (
  viewIds: SafeId<"workspaceView">[],
  expectedUpdatedAt?: string,
): Promise<unknown> => {
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);

  const context = asTestRaw<ReorderCtx>({
    featureAccessSnapshot: createFeatureAccessSnapshot({
      organizationId: ids.orgA,
      userId: ids.userA1,
      decisions: new Map(),
    }),
    scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    body: {
      viewIds,
      expectedUpdatedAt:
        expectedUpdatedAt ??
        (
          await testDb
            .select({ updatedAt: workspaces.lastActivityAt })
            .from(workspaces)
            .where(eq(workspaces.id, ids.wsA1))
        )
          .at(0)!
          .updatedAt.toISOString(),
    },
    createAuditRecorder: () => async () => undefined,
    memberRole: sessionMemberRole("owner"),
    recordAuditEvent: async () => undefined,
    request: new Request(`https://example.test/workspaces/${ids.wsA1}/views`),
    route: "/test/views/reorder",
    safeDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  });

  try {
    return await reorderViews.handler(context);
  } catch (error) {
    return error;
  }
};

const runList = async () =>
  await listViews.handler(
    createTestHandlerContext<Parameters<typeof listViews.handler>[0]>({
      audit: async () => undefined,
      safeDb: asTestRaw(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1)),
      scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      featureAccessSnapshot: createFeatureAccessSnapshot({
        organizationId: ids.orgA,
        userId: ids.userA1,
        decisions: new Map(),
      }),
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );

const runCreate = async (id: SafeId<"workspaceView">) =>
  await createView.handler(
    createTestHandlerContext<Parameters<typeof createView.handler>[0]>({
      audit: async () => undefined,
      safeDb: asTestRaw(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1)),
      scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      featureAccessSnapshot: createFeatureAccessSnapshot({
        organizationId: ids.orgA,
        userId: ids.userA1,
        decisions: new Map(),
      }),
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      body: { id, name: "Revision test", layout: emptyLayout },
    }),
  );

const runDelete = async (viewId: SafeId<"workspaceView">) =>
  await deleteView.handler(
    createTestHandlerContext<Parameters<typeof deleteView.handler>[0]>({
      audit: async () => undefined,
      safeDb: asTestRaw(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1)),
      scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      featureAccessSnapshot: createFeatureAccessSnapshot({
        organizationId: ids.orgA,
        userId: ids.userA1,
        decisions: new Map(),
      }),
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      params: { workspaceId: ids.wsA1, viewId },
    }),
  );

const readPositions = async (): Promise<
  { id: SafeId<"workspaceView">; position: number }[]
> =>
  await testDb
    .select({ id: workspaceViews.id, position: workspaceViews.position })
    .from(workspaceViews)
    .where(eq(workspaceViews.workspaceId, ids.wsA1))
    .orderBy(asc(workspaceViews.position));

const resetWorkspaceRevision = async () => {
  await testDb
    .update(workspaces)
    .set({ lastActivityAt: new Date("2000-01-01T00:00:00.000Z") })
    .where(eq(workspaces.id, ids.wsA1));
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (seededViewIds.length > 0) {
      await testDb
        .delete(workspaceViews)
        .where(inArray(workspaceViews.id, seededViewIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("views reorder integration", () => {
  test("persists positions matching a permuted order", async () => {
    const a = await seedView("Alpha", 0);
    const b = await seedView("Bravo", 1);
    const c = await seedView("Charlie", 2);

    const result = await runReorder([c, a, b]);

    expect(result).toEqual({});
    expect(await readPositions()).toEqual([
      { id: c, position: 0 },
      { id: a, position: 1 },
      { id: b, position: 2 },
    ]);
  });

  test("rejects a stale collection revision with VERSION_CONFLICT", async () => {
    const rows = await readPositions();
    const result = await runReorder(
      rows.map((row) => row.id),
      new Date(0).toISOString(),
    );

    expect(result).toMatchObject({
      code: 409,
      response: { code: "version_conflict" },
    });
  });

  test("view update rejects a stale revision with VERSION_CONFLICT", async () => {
    const viewId = (await readPositions()).at(0)!.id;
    const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const result = await updateView.handler(
      asTestRaw({
        featureAccessSnapshot: createFeatureAccessSnapshot({
          organizationId: ids.orgA,
          userId: ids.userA1,
          decisions: new Map(),
        }),
        scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
        body: {
          name: "Stale rename",
          expectedUpdatedAt: new Date(0).toISOString(),
        },
        params: { workspaceId: ids.wsA1, viewId },
        createAuditRecorder: () => async () => undefined,
        memberRole: sessionMemberRole("owner"),
        recordAuditEvent: async () => undefined,
        request: new Request("https://example.test/views/stale"),
        route: "/test/views/stale",
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        workspaceId: ids.wsA1,
      }),
    );

    expect(result).toMatchObject({
      code: 409,
      response: { code: "version_conflict" },
    });
  });

  test("creating a view advances the listed revision and rejects stale reorder", async () => {
    await resetWorkspaceRevision();
    await seedView("Revision baseline", 100);
    const before = await runList();
    expect(Array.isArray(before)).toBe(true);
    if (!Array.isArray(before)) {
      panic("View list must succeed");
    }
    const expectedUpdatedAt = before.at(0)?.updatedAt;
    expect(expectedUpdatedAt).toBeDefined();
    if (!expectedUpdatedAt) {
      panic("Listed views must have a revision");
    }

    const createdId = createSafeId<"workspaceView">();
    seededViewIds.push(createdId);
    expect(await runCreate(createdId)).toMatchObject({ id: createdId });

    const after = await runList();
    expect(Array.isArray(after)).toBe(true);
    if (!Array.isArray(after)) {
      panic("View list must succeed");
    }
    expect(after.at(0)?.updatedAt).not.toBe(expectedUpdatedAt);

    const idsNow = (await readPositions()).map((row) => row.id);
    expect(await runReorder(idsNow, expectedUpdatedAt)).toMatchObject({
      code: 409,
      response: { code: "version_conflict" },
    });
  });

  test("deleting a view advances the listed revision and rejects stale update", async () => {
    await resetWorkspaceRevision();
    const targetId = createSafeId<"workspaceView">();
    const deletedId = createSafeId<"workspaceView">();
    seededViewIds.push(targetId, deletedId);
    expect(await runCreate(targetId)).toMatchObject({ id: targetId });
    expect(await runCreate(deletedId)).toMatchObject({ id: deletedId });
    await resetWorkspaceRevision();
    const beforeDelete = await runList();
    expect(Array.isArray(beforeDelete)).toBe(true);
    if (!Array.isArray(beforeDelete)) {
      panic("View list must succeed");
    }
    const expectedUpdatedAt = beforeDelete.at(0)?.updatedAt;
    expect(expectedUpdatedAt).toBeDefined();
    if (!expectedUpdatedAt) {
      panic("Listed views must have a revision");
    }

    expect(await runDelete(deletedId)).toEqual({});

    const afterDelete = await runList();
    expect(Array.isArray(afterDelete)).toBe(true);
    if (!Array.isArray(afterDelete)) {
      panic("View list must succeed");
    }
    expect(afterDelete.at(0)?.updatedAt).not.toBe(expectedUpdatedAt);

    const result = await updateView.handler(
      asTestRaw({
        featureAccessSnapshot: createFeatureAccessSnapshot({
          organizationId: ids.orgA,
          userId: ids.userA1,
          decisions: new Map(),
        }),
        scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
        body: {
          name: "Stale after delete",
          expectedUpdatedAt,
        },
        params: { workspaceId: ids.wsA1, viewId: targetId },
        createAuditRecorder: () => async () => undefined,
        memberRole: sessionMemberRole("owner"),
        recordAuditEvent: async () => undefined,
        request: new Request("https://example.test/views/stale-after-delete"),
        route: "/test/views/stale-after-delete",
        safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        workspaceId: ids.wsA1,
      }),
    );
    expect(result).toMatchObject({
      code: 409,
      response: { code: "version_conflict" },
    });
  });
});
