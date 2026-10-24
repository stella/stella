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
        agendaFrom: undefined,
      }),
  );

  const agendaIds = agenda.map(({ entityId: id }) => id);
  // Dated tasks lead; the fixture's own undated tasks may follow them.
  expect(agendaIds.indexOf(olderTaskId)).toBeGreaterThanOrEqual(0);
  expect(agendaIds.indexOf(olderTaskId)).toBeLessThan(
    agendaIds.indexOf(undatedTaskId),
  );
  for (const excluded of [
    factId,
    eventId,
    closedTaskId,
    overdueTaskId,
    otherMatterTaskId,
    ...busyIds,
  ]) {
    expect(agendaIds).not.toContain(excluded);
  }
  // Without a reader date, the database's today is the boundary.
  expect(agendaIds).not.toContain(databaseYesterdayTaskId);
  // Undated open tasks follow the dated ones.
  expect(agendaIds).toContain(undatedTaskId);
  expect(agendaIds.indexOf(undatedTaskId)).toBeGreaterThan(0);
});

test("the reader's own date bounds the agenda before the limit applies", async () => {
  const yesterdayIds = Array.from(
    { length: LIMITS.overviewUpcomingAgenda + 1 },
    entityId,
  );
  const todayTaskId = entityId();
  await testDb.insert(entities).values([
    ...yesterdayIds.map((id, index) => ({
      id,
      workspaceId: ids.wsA1,
      kind: "task" as const,
      name: `Due yesterday ${index + 1}`,
      dueDate: sql`CURRENT_DATE - 1`,
      status: "open",
    })),
    {
      id: todayTaskId,
      workspaceId: ids.wsA1,
      kind: "task",
      name: "Due today",
      dueDate: sql`CURRENT_DATE`,
      status: "open",
    },
  ]);
  const dueDateOf = async (id: (typeof yesterdayIds)[number]) => {
    const [row] = await testDb
      .select({ dueDate: entities.dueDate })
      .from(entities)
      .where(inArray(entities.id, [id]));
    return row?.dueDate ?? undefined;
  };
  const yesterday = await dueDateOf(yesterdayIds[0] ?? todayTaskId);
  const today = await dueDateOf(todayTaskId);

  // A reader a day behind the database still sees the deadlines of its today.
  const behind = await scopedDb(
    async (tx) =>
      await readOverviewAgenda({
        tx,
        workspaceId: ids.wsA1,
        agendaFrom: yesterday,
      }),
  );
  // Ties on the due date order by id, so which of them fill the limit is not
  // fixed; every slot going to one of them is.
  expect(behind).toHaveLength(LIMITS.overviewUpcomingAgenda);
  for (const { entityId: id } of behind) {
    expect(yesterdayIds).toContain(id);
  }

  // Yesterday's deadlines never use up the limit for a reader on today.
  const current = await scopedDb(
    async (tx) =>
      await readOverviewAgenda({
        tx,
        workspaceId: ids.wsA1,
        agendaFrom: today,
      }),
  );
  const currentIds = current.map(({ entityId: id }) => id);
  expect(currentIds).toContain(todayTaskId);
  for (const id of yesterdayIds) {
    expect(currentIds).not.toContain(id);
  }
});
