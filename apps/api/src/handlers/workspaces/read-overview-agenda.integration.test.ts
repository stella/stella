import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readOverviewAgenda } from "./read-overview-agenda.query";

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;
const seededIds: ReturnType<typeof createSafeId<"entity">>[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
});

afterEach(async () => {
  if (seededIds.length === 0) {
    return;
  }
  await testDb.delete(entities).where(inArray(entities.id, seededIds));
  seededIds.length = 0;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const entityId = () => {
  const id = createSafeId<"entity">();
  seededIds.push(id);
  return id;
};

test("the agenda keeps an older open task that newer activity would push out", async () => {
  const olderTaskId = entityId();
  const undatedTaskId = entityId();
  const databaseYesterdayTaskId = entityId();
  const busyIds = Array.from(
    { length: LIMITS.overviewRecentEntities + 2 },
    entityId,
  );
  const factId = entityId();
  const eventId = entityId();
  const closedTaskId = entityId();
  const overdueTaskId = entityId();
  const otherMatterTaskId = entityId();

  await testDb.insert(entities).values([
    {
      id: olderTaskId,
      workspaceId: ids.wsA1,
      kind: "task",
      name: "Older open deadline",
      dueDate: "2999-01-01",
      status: "open",
      updatedAt: new Date("2000-01-01T00:00:00.000Z"),
    },
    {
      id: databaseYesterdayTaskId,
      workspaceId: ids.wsA1,
      kind: "task",
      name: "Due yesterday by the database calendar",
      dueDate: sql`CURRENT_DATE - 1`,
      status: "open",
    },
    {
      id: undatedTaskId,
      workspaceId: ids.wsA1,
      kind: "task",
      name: "Undated open task",
      status: "open",
      updatedAt: new Date("2000-01-01T00:00:00.000Z"),
    },
    // Newer activity that fills the recent-activity window.
    ...busyIds.map((id, index) => ({
      id,
      workspaceId: ids.wsA1,
      kind: "document" as const,
      name: `Recent document ${index + 1}`,
      updatedAt: new Date("2999-06-01T00:00:00.000Z"),
    })),
    // Reference list items are never agenda, dated or not.
    {
      id: factId,
      workspaceId: ids.wsA1,
      kind: "task",
      listItemType: "fact",
      name: "Dated fact",
      dueDate: "2998-01-01",
      status: "open",
    },
    {
      id: eventId,
      workspaceId: ids.wsA1,
      kind: "task",
      listItemType: "event",
      name: "Dated event",
      dueDate: "2998-01-02",
      status: "open",
    },
    {
      id: closedTaskId,
      workspaceId: ids.wsA1,
      kind: "task",
      name: "Closed deadline",
      dueDate: "2998-01-01",
      status: "done",
    },
    {
      id: overdueTaskId,
      workspaceId: ids.wsA1,
      kind: "task",
      name: "Overdue deadline",
      dueDate: "1900-01-01",
      status: "open",
    },
    {
      id: otherMatterTaskId,
      workspaceId: ids.wsA2,
      kind: "task",
      name: "Other matter deadline",
      dueDate: "2998-01-01",
      status: "open",
    },
  ]);

  const agenda = await scopedDb(
    async (tx) =>
      await readOverviewAgenda({
        tx,
        workspaceId: ids.wsA1,
      }),
  );

  const agendaIds = agenda.items.map(({ entityId: id }) => id);
  // Dated tasks lead; the fixture's own undated tasks may follow them.
  expect(agendaIds.indexOf(olderTaskId)).toBeGreaterThanOrEqual(0);
  expect(agendaIds.indexOf(olderTaskId)).toBeLessThan(
    agendaIds.indexOf(undatedTaskId),
  );
  for (const excluded of [
    factId,
    eventId,
    closedTaskId,
    otherMatterTaskId,
    ...busyIds,
  ]) {
    expect(agendaIds).not.toContain(excluded);
  }
  expect(agendaIds).toContain(overdueTaskId);
  expect(agendaIds).toContain(databaseYesterdayTaskId);
  expect(agenda.nextDeadline).toBe(agenda.items.at(0)?.dueDate ?? null);
  // Undated open tasks follow the dated ones.
  expect(agendaIds).toContain(undatedTaskId);
  expect(agendaIds.indexOf(undatedTaskId)).toBeGreaterThan(0);
});

test("a deadline stays in the agenda after the date rolls over", async () => {
  const taskId = entityId();
  await testDb.insert(entities).values({
    id: taskId,
    workspaceId: ids.wsA1,
    kind: "task",
    name: "Due today",
    dueDate: sql`CURRENT_DATE`,
    status: "open",
  });

  const beforeRollover = await scopedDb(
    async (tx) => await readOverviewAgenda({ tx, workspaceId: ids.wsA1 }),
  );
  expect(beforeRollover.items.map(({ entityId: id }) => id)).toContain(taskId);

  await testDb
    .update(entities)
    .set({ dueDate: sql`CURRENT_DATE - 1` })
    .where(inArray(entities.id, [taskId]));

  const afterRollover = await scopedDb(
    async (tx) => await readOverviewAgenda({ tx, workspaceId: ids.wsA1 }),
  );
  expect(afterRollover.items.map(({ entityId: id }) => id)).toContain(taskId);
  expect(afterRollover.totalCount).toBe(beforeRollover.totalCount);
});

test("the capped agenda reports every open task and the earliest overdue deadline", async () => {
  const existingAgenda = await scopedDb(
    async (tx) => await readOverviewAgenda({ tx, workspaceId: ids.wsA1 }),
  );
  const taskCount = LIMITS.overviewUpcomingAgenda + 3;
  const taskIds = Array.from({ length: taskCount }, entityId);

  await testDb.insert(entities).values(
    taskIds.map((id, index) => ({
      id,
      workspaceId: ids.wsA1,
      kind: "task" as const,
      name: `Overflow agenda task ${index + 1}`,
      dueDate:
        index === 0
          ? "1900-01-01"
          : `2999-01-${String(index + 1).padStart(2, "0")}`,
      status: "open",
    })),
  );

  const agenda = await scopedDb(
    async (tx) => await readOverviewAgenda({ tx, workspaceId: ids.wsA1 }),
  );

  expect(agenda.items).toHaveLength(LIMITS.overviewUpcomingAgenda);
  expect(agenda.totalCount).toBe(existingAgenda.totalCount + taskCount);
  expect(agenda.items.at(0)?.entityId).toBe(taskIds.at(0));
  expect(agenda.nextDeadline).toBe("1900-01-01");
});
