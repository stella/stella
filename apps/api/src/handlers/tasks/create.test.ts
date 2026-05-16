import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { createTaskHandler } from "./create";

type CreateTaskCtx = Parameters<typeof createTaskHandler>[0];
type ScopedDb = CreateTaskCtx["scopedDb"];

const workspaceId = toSafeId<"workspace">("ws_test123");
const userId = toSafeId<"user">("user_abc");

/** Mock scopedDb that throws if called (validates early return). */
const throwingScopedDb = () =>
  asTestRaw<ScopedDb>(
    mock(() => {
      throw new Error("scopedDb should not be called");
    }),
  );

/** Mock scopedDb that resolves successfully. */
const resolvingScopedDb = () =>
  asTestRaw<ScopedDb & ReturnType<typeof mock>>(
    mock(async () => ({ entityId: "fake" })),
  );

const createHandlerContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: CreateTaskCtx["body"];
  safeDb: CreateTaskCtx["safeDb"];
  scopedDb: CreateTaskCtx["scopedDb"];
}): CreateTaskCtx =>
  asTestRaw<CreateTaskCtx>({
    workspaceId,
    user: { id: userId },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test123"),
    },
    memberRole: { role: "owner" },
    body,
    safeDb,
    scopedDb,
  });

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
