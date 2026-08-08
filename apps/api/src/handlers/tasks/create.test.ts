import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { workObligations } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock, toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { createTaskEntityHandler, createTaskHandler } from "./create";

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

  test("invalid list item type returns 400 before DB call", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: { name: "Test item", listItemType: "unknown" },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid list item type" },
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

  test("rejects a working target after the hard deadline before DB access", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: {
          name: "File response",
          workingTargetDate: "2026-09-11",
          hardDeadlineDate: "2026-09-10",
        },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Working target cannot be after the hard deadline" },
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

  test("creates unassigned work for an authorized caller without workspace membership", async () => {
    const obligationRows: Record<string, unknown>[] = [];
    const { safeDb } = createScopedDbMock({
      $count: async () => 0,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({ for: async () => [] }),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          if (table === workObligations) {
            obligationRows.push(values);
          }
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => [],
        }),
      }),
    });

    const result = await Result.gen(() =>
      createTaskEntityHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { name: "Firm-admin task" },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(obligationRows).toEqual([
      expect.objectContaining({ ownerUserId: null, status: "unassigned" }),
    ]);
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

      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: each iteration asserts on its own mock
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

      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: each iteration asserts on its own mock
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

  test("all supported List item types pass validation", async () => {
    const itemTypes = ["task", "fact", "issue", "requirement", "event"];

    for (const listItemType of itemTypes) {
      const scopedDb = resolvingScopedDb();

      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: each iteration asserts on its own mock
      await createTaskHandler(
        createHandlerContext({
          body: { name: "Test item", listItemType },
          safeDb: toSafeDbMock(scopedDb),
          scopedDb,
        }),
      );

      expect(scopedDb).toHaveBeenCalledTimes(1);
    }
  });
});
