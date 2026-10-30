import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract/entity-options";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, taskAssignees, workspaces } from "@/api/db/schema";
import { createMembershipSafeDb } from "@/api/db/scoped";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  myOpenTasksScalingScenario,
  seedMyOpenTasksScaling,
} from "@/api/tests/read-scaling/my-open-tasks";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listMyOpenTasks from "./list";

type ListCtx = Parameters<typeof listMyOpenTasks.handler>[0];

// Fixture membership (rls-helpers): userA1 belongs to wsA1 and wsA2 in org A
// and to wsB1 in org B; userA2 belongs to wsA2 only.
let testDb: TestDatabase;
let ids: TestIds;

const mineA1 = createSafeId<"entity">();
const mineA2Dated = createSafeId<"entity">();
const mineA2Undated = createSafeId<"entity">();
const mineDone = createSafeId<"entity">();
const mineCancelled = createSafeId<"entity">();
const othersTask = createSafeId<"entity">();
const unassignedTask = createSafeId<"entity">();
const mineOtherFirm = createSafeId<"entity">();
const taskIds = [
  mineA1,
  mineA2Dated,
  mineA2Undated,
  mineDone,
  mineCancelled,
  othersTask,
  unassignedTask,
  mineOtherFirm,
];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const task = (
    id: SafeId<"entity">,
    workspaceId: SafeId<"workspace">,
    fields: { dueDate?: string; status?: string } = {},
  ) => ({ id, workspaceId, kind: "task" as const, name: id, ...fields });
  await testDb.insert(entities).values([
    task(mineA1, ids.wsA1, {
      dueDate: "2026-03-01",
      status: TASK_STATUS.IN_PROGRESS,
    }),
    task(mineA2Dated, ids.wsA2, { dueDate: "2026-02-01" }),
    task(mineA2Undated, ids.wsA2, { status: TASK_STATUS.OPEN }),
    task(mineDone, ids.wsA1, {
      dueDate: "2026-01-01",
      status: TASK_STATUS.DONE,
    }),
    task(mineCancelled, ids.wsA2, { status: TASK_STATUS.CANCELLED }),
    task(othersTask, ids.wsA2, { dueDate: "2026-01-15" }),
    task(unassignedTask, ids.wsA1, { dueDate: "2026-01-20" }),
    task(mineOtherFirm, ids.wsB1, { dueDate: "2026-01-10" }),
  ]);
  const assign = (
    entityId: SafeId<"entity">,
    workspaceId: SafeId<"workspace">,
    userId: SafeId<"user">,
  ) => ({
    id: createSafeId<"taskAssignee">(),
    entityId,
    workspaceId,
    userId,
    role: "assignee" as const,
  });
  await testDb
    .insert(taskAssignees)
    .values([
      assign(mineA1, ids.wsA1, ids.userA1),
      assign(mineA2Dated, ids.wsA2, ids.userA1),
      assign(mineA2Undated, ids.wsA2, ids.userA1),
      assign(mineDone, ids.wsA1, ids.userA1),
      assign(mineCancelled, ids.wsA2, ids.userA1),
      assign(othersTask, ids.wsA2, ids.userA2),
      assign(mineOtherFirm, ids.wsB1, ids.userA1),
    ]);
});

afterAll(async () => {
  try {
    await testDb.delete(entities).where(inArray(entities.id, taskIds));
  } finally {
    await releaseRlsFixture();
  }
});

const listAs = async (userId: SafeId<"user">, query: ListCtx["query"] = {}) => {
  const identity = {
    organizationId: ids.orgA,
    serverValidatedWorkspaceIds: [],
    userId,
  };
  return await listMyOpenTasks.handler(
    asTestRaw<ListCtx>({
      query,
      request: new Request("https://example.test/v1/tasks"),
      route: "/v1/tasks" satisfies ApiRoutePath,
      safeDb: asTestRaw<SafeDb>(createMembershipSafeDb(testDb, identity)),
      // Org A's matters only, as the access map would hand them over.
      getActiveWorkspaceIds: async () => [ids.wsA1, ids.wsA2],
      session: { activeOrganizationId: ids.orgA },
      user: { id: userId },
      memberRole: sessionMemberRole("member"),
    }),
  );
};

const pageOf = (result: Awaited<ReturnType<typeof listAs>>) => {
  if (!("items" in result)) {
    return expect.unreachable(`list failed: ${JSON.stringify(result)}`);
  }
  return result;
};

describe("GET /v1/tasks", () => {
  test("lists the caller's open tasks across matters, each naming its matter", async () => {
    const page = pageOf(await listAs(ids.userA1));
    const names = new Map(
      (
        await testDb
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, [ids.wsA1, ids.wsA2]))
      ).map((row) => [row.id, row.name]),
    );

    // Done and cancelled tasks, someone else's, unassigned ones and another
    // firm's stay out; undated tasks sort last.
    expect(page.items.map((item) => item.id)).toEqual([
      mineA2Dated,
      mineA1,
      mineA2Undated,
    ]);
    expect(
      page.items.map(({ matterId, matterName }) => ({ matterId, matterName })),
    ).toEqual([
      { matterId: ids.wsA2, matterName: names.get(ids.wsA2) ?? "" },
      { matterId: ids.wsA1, matterName: names.get(ids.wsA1) ?? "" },
      { matterId: ids.wsA2, matterName: names.get(ids.wsA2) ?? "" },
    ]);
    expect(page.items[0]).toMatchObject({
      status: null,
      itemType: "task",
      dueDate: "2026-02-01",
    });
    expect(page.nextCursor).toBeNull();
  });

  test("pages with limit and cursor", async () => {
    const first = pageOf(await listAs(ids.userA1, { limit: 2 }));
    expect(first.items.map((item) => item.id)).toEqual([mineA2Dated, mineA1]);
    expect(first.nextCursor).not.toBeNull();

    const second = pageOf(
      await listAs(ids.userA1, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      }),
    );
    expect(second.items.map((item) => item.id)).toEqual([mineA2Undated]);
    expect(second.nextCursor).toBeNull();
  });

  test("another member sees only their own tasks", async () => {
    const page = pageOf(await listAs(ids.userA2));
    expect(page.items.map((item) => item.id)).toEqual([othersTask]);
  });

  test("a cursor this list did not produce is refused", async () => {
    expect(await listAs(ids.userA1, { cursor: "not-a-cursor" })).toEqual({
      code: 400,
      response: {
        code: "invalid_cursor",
        message: "Invalid cursor",
        hint: "Restart the list without a cursor.",
      },
    });
  });
});

describe("GET /v1/tasks scaling", () => {
  test("a page costs the same queries however many matters and tasks exist", async () => {
    // The scenario lists only the seeded matters, so the fixture's own tasks
    // never reach the page.
    const seed = async (size: number) =>
      await seedMyOpenTasksScaling(testDb, {
        organizationId: ids.orgA,
        clientId: ids.contactA,
        userId: ids.userA2,
        size,
      });
    const small = await seed(10);
    const large = await seed(200);
    try {
      const at10 = await myOpenTasksScalingScenario.measure(small);
      const at200 = await myOpenTasksScalingScenario.measure(large);
      expect(at10.rows).toBe(10);
      expect(at200.rows).toBe(10);
      expect(at10.statements).toBeGreaterThan(0);
      expect(readScalingViolations({ small: at10, large: at200 })).toEqual([]);
    } finally {
      await small.cleanup();
      await large.cleanup();
    }
  });
});
