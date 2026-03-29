import { describe, expect, mock, test } from "bun:test";

import type { SafeId } from "@/api/lib/branded-types";

import { createTaskHandler } from "./create";

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded type in test
const workspaceId = "ws_test123" as SafeId<"workspace">;
const userId = "user_abc";

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
  scopedDb,
}: {
  body: Parameters<typeof createTaskHandler>[0]["body"];
  scopedDb: Parameters<typeof createTaskHandler>[0]["scopedDb"];
}): Parameters<typeof createTaskHandler>[0] => ({
  workspaceId,
  user: {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded type in test
    id: userId as SafeId<"user">,
  },
  session: {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded type in test
    activeOrganizationId: "org_test123" as SafeId<"organization">,
    token: "token",
  },
  memberRole: { role: "owner" },
  body,
  scopedDb,
});

describe("createTaskHandler validation", () => {
  test("invalid status returns 400 before DB call", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: { name: "Test task", status: "bogus" },
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
          scopedDb,
        }),
      );

      expect(scopedDb).toHaveBeenCalledTimes(1);
    }
  });
});
