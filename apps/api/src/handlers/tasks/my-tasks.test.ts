import { describe, expect, mock, test } from "bun:test";

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
  test("returns a bounded assignment-keyset page without dropping its cursor", async () => {
    const findAssignments = mock(async () =>
      entityIds.map((entityId) => ({ entityId, role: "assignee" })),
    );
    const findTasks = mock(async () => [
      { id: entityIds[1], name: "Second" },
      { id: entityIds[0], name: "First" },
    ]);
    const { scopedDb } = createScopedDbMock({
      query: {
        entities: { findMany: findTasks },
        taskAssignees: { findMany: findAssignments },
      },
    });

    const page = await myTasksHandler({
      cursorEntityId: null,
      limit: 2,
      scopedDb,
      userId: toSafeId<"user">("user-test"),
    });

    expect(page.items.map((task) => task.id)).toEqual(entityIds.slice(0, 2));
    expect(page.limit).toBe(2);
    expect(decodePaginationCursor(page.nextCursor ?? "")).toEqual([
      entityIds[1],
    ]);
    expect(findAssignments).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, orderBy: { entityId: "asc" } }),
    );
    expect(findTasks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2 }),
    );
  });

  test("applies the entity cursor to the next assignment page", async () => {
    const findAssignments = mock(async () => []);
    const { scopedDb, getCallCount } = createScopedDbMock({
      query: {
        entities: { findMany: mock(async () => []) },
        taskAssignees: { findMany: findAssignments },
      },
    });

    const page = await myTasksHandler({
      cursorEntityId: entityIds[1],
      limit: 2,
      scopedDb,
      userId: toSafeId<"user">("user-test"),
    });

    expect(page).toEqual({ items: [], limit: 2, nextCursor: null });
    expect(findAssignments).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityId: { gt: entityIds[1] },
        }),
      }),
    );
    expect(getCallCount()).toBe(1);
  });
});
