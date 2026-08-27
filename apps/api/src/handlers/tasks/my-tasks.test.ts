import { describe, expect, mock, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import { decodePaginationCursor } from "@/api/lib/pagination";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { myTasksHandler } from "./my-tasks";

const entityIds = [
  toSafeId<"entity">("00000000-0000-4000-8000-000000000001"),
  toSafeId<"entity">("00000000-0000-4000-8000-000000000002"),
  toSafeId<"entity">("00000000-0000-4000-8000-000000000003"),
] as const;

describe("myTasksHandler", () => {
  test("returns a bounded due-date-keyset page without dropping its cursor", async () => {
    const visibleTasks = [
      { entityId: entityIds[0], sortDate: "2026-08-08" },
      { entityId: entityIds[1], sortDate: "2026-08-09" },
      { entityId: entityIds[2], sortDate: "9999-12-31" },
    ];
    const limitPage = mock(async () => visibleTasks);
    const orderPage = mock(() => ({ limit: limitPage }));
    const wherePage = mock(() => ({ orderBy: orderPage }));
    const joinPage = mock(() => ({ where: wherePage }));
    const fromPage = mock(() => ({ innerJoin: joinPage }));
    const selectPage = mock(() => ({ from: fromPage }));
    const findTasks = mock(async () => [
      { id: entityIds[1], name: "Second" },
      { id: entityIds[0], name: "First" },
    ]);
    const { scopedDb } = createScopedDbMock({
      query: {
        entities: { findMany: findTasks },
      },
      select: selectPage,
    });

    const page = await myTasksHandler({
      cursor: null,
      limit: 2,
      scopedDb,
      status: null,
      userId: toSafeId<"user">("user-test"),
      activeWorkspaceIds: [toSafeId<"workspace">("workspace-test")],
    });

    expect(page.items.map((task) => task.id)).toEqual(entityIds.slice(0, 2));
    expect(page.limit).toBe(2);
    expect(decodePaginationCursor(page.nextCursor ?? "")).toEqual([
      "2026-08-09",
      entityIds[1],
    ]);
    expect(limitPage).toHaveBeenCalledWith(3);
    expect(orderPage).toHaveBeenCalledTimes(1);
    expect(findTasks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2 }),
    );
  });

  test("applies the due-date cursor and status before selecting a page", async () => {
    const limitPage = mock(async () => []);
    const wherePage = mock(() => ({
      orderBy: () => ({ limit: limitPage }),
    }));
    const { scopedDb, getCallCount } = createScopedDbMock({
      query: {
        entities: { findMany: mock(async () => []) },
      },
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: wherePage }),
        }),
      }),
    });

    const page = await myTasksHandler({
      cursor: { entityId: entityIds[1], sortDate: "2026-08-09" },
      limit: 2,
      scopedDb,
      status: "open",
      userId: toSafeId<"user">("user-test"),
      activeWorkspaceIds: [toSafeId<"workspace">("workspace-test")],
    });

    expect(page).toEqual({ items: [], limit: 2, nextCursor: null });
    expect(wherePage).toHaveBeenCalledTimes(1);
    expect(limitPage).toHaveBeenCalledWith(3);
    expect(getCallCount()).toBe(1);
  });

  test("scopes the assignee query to the caller's active workspaces", async () => {
    const wherePage = mock(() => ({
      orderBy: () => ({ limit: mock(async () => []) }),
    }));
    const { scopedDb } = createScopedDbMock({
      query: {
        entities: { findMany: mock(async () => []) },
      },
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: wherePage }),
        }),
      }),
    });
    const activeWorkspaceId = toSafeId<"workspace">(
      "00000000-0000-4000-8000-0000000000aa",
    );

    await myTasksHandler({
      cursor: null,
      limit: 2,
      scopedDb,
      status: null,
      userId: toSafeId<"user">("user-test"),
      activeWorkspaceIds: [activeWorkspaceId],
    });

    const condition = wherePage.mock.calls.at(0)?.[0] as {
      getSQL: () => unknown;
    };
    const compiled = new PgDialect().sqlToQuery(
      condition.getSQL() as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(compiled.sql).toContain("workspace_id");
    expect(compiled.params).toContain(activeWorkspaceId);
  });
});
