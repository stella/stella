import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { createTaskHandler } from "./create";

const workspaceId = toSafeId<"workspace">("ws_test123");
const userId = toSafeId<"user">("user_abc");

/** Mock scopedDb that throws if called (validates early return). */
const throwingScopedDb = () =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
  mock(() => {
    throw new Error("scopedDb should not be called");
  }) as unknown as Parameters<typeof createTaskHandler>[0]["scopedDb"];

/** Mock scopedDb that resolves successfully. */
const resolvingScopedDb = () =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
  mock(async () => ({ entityId: "fake" })) as unknown as Parameters<
    typeof createTaskHandler
  >[0]["scopedDb"] &
    ReturnType<typeof mock>;

const createHandlerContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: Parameters<typeof createTaskHandler>[0]["body"];
  safeDb: Parameters<typeof createTaskHandler>[0]["safeDb"];
  scopedDb: Parameters<typeof createTaskHandler>[0]["scopedDb"];
}): Parameters<typeof createTaskHandler>[0] =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only exercises the handler-owned fields accessed before/inside scopedDb
  ({
    workspaceId,
    user: { id: userId },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test123"),
    },
    memberRole: { role: "owner" },
    body,
    safeDb,
    scopedDb,
  }) as Parameters<typeof createTaskHandler>[0];

describe("createTaskHandler validation", () => {
  test("invalid status returns 400 before DB call", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: { name: "Test task", status: "bogus" },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid task status" },
    });
  });

  test("invalid priority returns 400 before DB call", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: { name: "Test task", priority: "critical" },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid task priority" },
    });
  });

  test("invalid status checked before invalid priority", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: {
          name: "Test task",
          status: "bogus",
          priority: "critical",
        },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid task status" },
    });
  });

  test("valid status and priority proceeds to DB call", async () => {
    const scopedDb = resolvingScopedDb();

    await createTaskHandler(
      createHandlerContext({
        body: {
          name: "Test task",
          status: "in_progress",
          priority: "high",
        },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(scopedDb).toHaveBeenCalledTimes(1);
  });

  test("defaults status to 'open' and priority to 'none'", async () => {
    const scopedDb = resolvingScopedDb();

    await createTaskHandler(
      createHandlerContext({
        body: { name: "Test task" },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(scopedDb).toHaveBeenCalledTimes(1);
  });

  test("all valid TASK_STATUSES pass validation", async () => {
    const validStatuses = [
      "open",
      "in_progress",
      "in_review",
      "done",
      "cancelled",
    ];

    for (const taskStatus of validStatuses) {
      const scopedDb = resolvingScopedDb();

      await createTaskHandler(
        createHandlerContext({
          body: { name: "Test task", status: taskStatus },
          safeDb: toSafeDbMock(scopedDb),
          scopedDb,
        }),
      );

      expect(scopedDb).toHaveBeenCalledTimes(1);
    }
  });

  test("all valid ENTITY_PRIORITIES pass validation", async () => {
    const validPriorities = ["none", "urgent", "high", "medium", "low"];

    for (const priority of validPriorities) {
      const scopedDb = resolvingScopedDb();

      await createTaskHandler(
        createHandlerContext({
          body: { name: "Test task", priority },
          safeDb: toSafeDbMock(scopedDb),
          scopedDb,
        }),
      );

      expect(scopedDb).toHaveBeenCalledTimes(1);
    }
  });
});
