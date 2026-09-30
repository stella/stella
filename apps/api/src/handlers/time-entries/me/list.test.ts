import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { timeEntries, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listMyTimeEntries from "./list";

type ListCtx = Parameters<typeof listMyTimeEntries.handler>[0];

const DAY = "2024-06-30";
const BEFORE_DAY = "2024-06-29";
const AFTER_DAY = "2024-07-01";
const visibleIds = [
  createSafeId<"timeEntry">(),
  createSafeId<"timeEntry">(),
] as const;
const hiddenIds = [
  createSafeId<"timeEntry">(),
  createSafeId<"timeEntry">(),
  createSafeId<"timeEntry">(),
  createSafeId<"timeEntry">(),
  createSafeId<"timeEntry">(),
] as const;
const afterDayId = createSafeId<"timeEntry">();
const inaccessibleWorkspaceId = createSafeId<"workspace">();
const deletingWorkspaceId = createSafeId<"workspace">();

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb.insert(workspaces).values([
    {
      id: inaccessibleWorkspaceId,
      organizationId: ids.orgA,
      clientId: ids.contactA,
      name: "Inaccessible matter",
      reference: `TEST-${inaccessibleWorkspaceId}`,
    },
    {
      id: deletingWorkspaceId,
      organizationId: ids.orgA,
      clientId: ids.contactA,
      name: "Deleting matter",
      reference: `TEST-${deletingWorkspaceId}`,
      status: "deleting",
    },
  ]);

  const entry = ({
    id,
    organizationId,
    workspaceId,
    userId,
    dateWorked,
  }: {
    id: (typeof visibleIds)[number];
    organizationId: TestIds["orgA"];
    workspaceId: TestIds["wsA1"];
    userId: TestIds["userA1"];
    dateWorked: string;
  }) => ({
    id,
    organizationId,
    workspaceId,
    userId,
    dateWorked,
    timezoneId: "UTC",
    durationMinutes: 30,
    billedMinutes: 30,
    rateAtEntry: cents(0),
    currency: "USD",
    narrative: "Test work",
  });

  await testDb.insert(timeEntries).values([
    entry({
      id: visibleIds[0],
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      dateWorked: DAY,
    }),
    entry({
      id: visibleIds[1],
      organizationId: ids.orgA,
      workspaceId: ids.wsA2,
      userId: ids.userA1,
      dateWorked: DAY,
    }),
    entry({
      id: hiddenIds[0],
      organizationId: ids.orgA,
      workspaceId: inaccessibleWorkspaceId,
      userId: ids.userA1,
      dateWorked: DAY,
    }),
    entry({
      id: hiddenIds[1],
      organizationId: ids.orgA,
      workspaceId: deletingWorkspaceId,
      userId: ids.userA1,
      dateWorked: DAY,
    }),
    entry({
      id: hiddenIds[2],
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      userId: ids.userA1,
      dateWorked: DAY,
    }),
    entry({
      id: hiddenIds[3],
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA2,
      dateWorked: DAY,
    }),
    entry({
      id: hiddenIds[4],
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      dateWorked: BEFORE_DAY,
    }),
    entry({
      id: afterDayId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      dateWorked: AFTER_DAY,
    }),
  ]);
});

afterAll(async () => {
  try {
    await testDb
      .delete(timeEntries)
      .where(
        inArray(timeEntries.id, [...visibleIds, ...hiddenIds, afterDayId]),
      );
    await testDb
      .delete(workspaces)
      .where(
        inArray(workspaces.id, [inaccessibleWorkspaceId, deletingWorkspaceId]),
      );
  } finally {
    await releaseRlsFixture();
  }
});

const listFor = async (query: ListCtx["query"]) =>
  await listMyTimeEntries.handler(
    asTestRaw<ListCtx>({
      query,
      request: new Request("https://example.test/time-entries/me"),
      route: "/time-entries/me",
      safeDb: createSafeDb(
        testDb,
        [ids.wsA1, ids.wsA2, deletingWorkspaceId],
        ids.orgA,
        ids.userA1,
      ),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      memberRole: { role: "member" },
    }),
  );

type MyTimeEntryPage = Extract<
  Awaited<ReturnType<typeof listMyTimeEntries.handler>>,
  { items: unknown[] }
>;
const isPage = (value: unknown): value is MyTimeEntryPage =>
  typeof value === "object" &&
  value !== null &&
  "items" in value &&
  Array.isArray(value.items);

describe("personal time entries", () => {
  test("shows only the user's accessible matters in the active organization on the requested date", async () => {
    const result = await listFor({ date: DAY });
    if (!isPage(result)) {
      throw new Error(`unexpected list response: ${JSON.stringify(result)}`);
    }

    expect(result.items.map(({ id }) => id).toSorted()).toEqual(
      [...visibleIds].toSorted(),
    );
    expect(
      result.items.map(({ workspaceId }) => workspaceId).toSorted(),
    ).toEqual([ids.wsA1, ids.wsA2].toSorted());
    expect(
      result.items.map(({ workspaceName }) => workspaceName).toSorted(),
    ).toEqual(["WS A1", "WS A2"]);
    expect(result.nextCursor).toBeNull();
  });

  test("paginates by stable entry id without repeating or skipping a matter", async () => {
    const first = await listFor({ date: DAY, limit: 1 });
    if (!isPage(first) || first.nextCursor === null) {
      throw new Error(`unexpected first page: ${JSON.stringify(first)}`);
    }
    expect(first.items).toHaveLength(1);
    const firstItem = first.items.at(0);
    if (!firstItem) {
      throw new Error("first page is empty");
    }
    expect(first.nextCursor).toBe(encodePaginationCursor([firstItem.id]));

    const second = await listFor({
      date: DAY,
      limit: 1,
      cursor: first.nextCursor,
    });
    if (!isPage(second)) {
      throw new Error(`unexpected second page: ${JSON.stringify(second)}`);
    }
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map(({ id }) => id)).toEqual(
      [...visibleIds].toSorted(),
    );
  });

  test("rejects impossible calendar dates and malformed cursors", async () => {
    expect(await listFor({ date: "2024-06-31" })).toMatchObject({
      code: 400,
      response: { code: "invalid_date_worked" },
    });
    expect(
      await listFor({ date: DAY, cursor: encodePaginationCursor(["bad-id"]) }),
    ).toMatchObject({
      code: 400,
      response: { code: "invalid_cursor" },
    });
  });
});

test("my day includes the owner's internal work without exposing other members or tenants", async () => {
  const own = createSafeId<"timeEntry">();
  const other = createSafeId<"timeEntry">();
  const foreign = createSafeId<"timeEntry">();
  const internal = {
    workspaceId: null,
    activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
    dateWorked: DAY,
    timezoneId: "UTC",
    durationMinutes: 37,
    billedMinutes: 0,
    rateAtEntry: cents(0),
    currency: UNPRICED_TIME_ENTRY_CURRENCY,
    billable: false,
    noCharge: false,
    narrative: "Internal work",
  };
  await testDb.insert(timeEntries).values([
    { ...internal, id: own, organizationId: ids.orgA, userId: ids.userA1 },
    { ...internal, id: other, organizationId: ids.orgA, userId: ids.userA2 },
    { ...internal, id: foreign, organizationId: ids.orgB, userId: ids.userA1 },
  ]);
  try {
    const page = await listFor({ date: DAY });
    if (!isPage(page)) {
      throw new Error(`unexpected day page: ${JSON.stringify(page)}`);
    }
    expect(page.items.map(({ id }) => id).toSorted()).toEqual(
      [...visibleIds, own].toSorted(),
    );
    expect(page.items.find(({ id }) => id === own)).toMatchObject({
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      workspaceId: null,
      workspaceName: null,
      workspaceReference: null,
      durationMinutes: 37,
      billedMinutes: 0,
    });
    for (const id of visibleIds) {
      expect(page.items.find((row) => row.id === id)).toMatchObject({
        activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
      });
    }
    const withoutMatters = await listMyTimeEntries.handler(
      asTestRaw<ListCtx>({
        query: { date: DAY },
        request: new Request("https://example.test/time-entries/me"),
        route: "/time-entries/me",
        safeDb: createSafeDb(testDb, [], ids.orgA, ids.userA1),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        memberRole: { role: "member" },
      }),
    );
    if (!isPage(withoutMatters)) {
      throw new Error(
        `unexpected internal page: ${JSON.stringify(withoutMatters)}`,
      );
    }
    expect(withoutMatters.items.map(({ id }) => id)).toEqual([own]);
  } finally {
    await testDb
      .delete(timeEntries)
      .where(inArray(timeEntries.id, [own, other, foreign]));
  }
});
