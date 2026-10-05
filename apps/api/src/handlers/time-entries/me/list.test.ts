import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { timeDailyTargets, timeEntries, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
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
const SUMMARY_DAY = "2031-02-03";
const EMPTY_DAY = "2031-02-04";
const summaryIds = [
  createSafeId<"timeEntry">(),
  createSafeId<"timeEntry">(),
] as const;
const internalWorkspaceId = createSafeId<"workspace">();
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
      id: internalWorkspaceId,
      organizationId: ids.orgA,
      clientId: null,
      name: "Internal matter",
      reference: `TEST-${internalWorkspaceId}`,
    },
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
    {
      ...entry({
        id: summaryIds[0],
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        dateWorked: SUMMARY_DAY,
      }),
      durationMinutes: 40,
      billedMinutes: 90,
    },
    {
      ...entry({
        id: summaryIds[1],
        organizationId: ids.orgA,
        workspaceId: internalWorkspaceId,
        userId: ids.userA1,
        dateWorked: SUMMARY_DAY,
      }),
      workspaceId: null,
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      durationMinutes: 25,
      billedMinutes: 0,
      billable: false,
    },
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
        inArray(timeEntries.id, [
          ...visibleIds,
          ...hiddenIds,
          ...summaryIds,
          afterDayId,
        ]),
      );
    await testDb
      .delete(workspaces)
      .where(
        inArray(workspaces.id, [
          inaccessibleWorkspaceId,
          deletingWorkspaceId,
          internalWorkspaceId,
        ]),
      );
  } finally {
    await releaseRlsFixture();
  }
});

const listFor = async (query: ListCtx["query"]) =>
  await listMyTimeEntries.handler(
    withTimeBillingEnrolment(
      asTestRaw<ListCtx>({
        query,
        request: new Request("https://example.test/time-entries/me"),
        route: "/time-entries/me",
        safeDb: createSafeDb(
          testDb,
          [ids.wsA1, ids.wsA2, deletingWorkspaceId, internalWorkspaceId],
          ids.orgA,
          ids.userA1,
        ),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        memberRole: sessionMemberRole("member"),
      }),
    ),
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

const withTargets = async (
  minutes: number | null | undefined,
  check: () => Promise<void>,
) => {
  await testDb
    .insert(timeDailyTargets)
    .values([
      { organizationId: ids.orgB, userId: ids.userA1, minutes: 900 },
      ...(minutes === undefined
        ? []
        : [{ organizationId: ids.orgA, userId: ids.userA1, minutes }]),
    ]);
  try {
    await check();
  } finally {
    await testDb
      .delete(timeDailyTargets)
      .where(
        and(
          eq(timeDailyTargets.userId, ids.userA1),
          inArray(timeDailyTargets.organizationId, [ids.orgA, ids.orgB]),
        ),
      );
  }
};

describe("personal daily time summary", () => {
  test("leaves both values null for absent or cleared targets despite a foreign-organization target", async () => {
    for (const minutes of [undefined, null]) {
      await withTargets(minutes, async () => {
        expect(await listFor({ date: SUMMARY_DAY })).toMatchObject({
          loggedTodayMinutes: 65,
          dailyTargetMinutes: null,
          leftTodayMinutes: null,
        });
      });
    }
  });

  test("subtracts client and internal duration rather than billed minutes on every page", async () => {
    await withTargets(120, async () => {
      const complete = await listFor({ date: SUMMARY_DAY });
      expect(complete).toMatchObject({
        loggedTodayMinutes: 65,
        dailyTargetMinutes: 120,
        leftTodayMinutes: 55,
      });
      const first = await listFor({ date: SUMMARY_DAY, limit: 1 });
      if (!isPage(first) || first.nextCursor === null) {
        throw new Error(`unexpected first page: ${JSON.stringify(first)}`);
      }
      const second = await listFor({
        date: SUMMARY_DAY,
        limit: 1,
        cursor: first.nextCursor,
      });
      if (!isPage(second)) {
        throw new Error(`unexpected second page: ${JSON.stringify(second)}`);
      }
      expect(first.items).toHaveLength(1);
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map(({ id }) => id)).toEqual(
        [...summaryIds].toSorted(),
      );
      for (const page of [first, second]) {
        expect(page).toMatchObject({
          loggedTodayMinutes: 65,
          dailyTargetMinutes: 120,
          leftTodayMinutes: 55,
        });
      }
    });
  });

  test("excludes inaccessible, deleting, foreign-organization, other-user and other-date work", async () => {
    await withTargets(120, async () => {
      expect(await listFor({ date: DAY })).toMatchObject({
        loggedTodayMinutes: 60,
        dailyTargetMinutes: 120,
        leftTodayMinutes: 60,
      });
    });
  });

  test("clamps remaining minutes at zero after reducing a target below logged time", async () => {
    await withTargets(120, async () => {
      expect(await listFor({ date: SUMMARY_DAY })).toMatchObject({
        loggedTodayMinutes: 65,
        dailyTargetMinutes: 120,
        leftTodayMinutes: 55,
      });
      await testDb
        .update(timeDailyTargets)
        .set({ minutes: 30 })
        .where(
          and(
            eq(timeDailyTargets.organizationId, ids.orgA),
            eq(timeDailyTargets.userId, ids.userA1),
          ),
        );
      expect(await listFor({ date: SUMMARY_DAY })).toMatchObject({
        loggedTodayMinutes: 65,
        dailyTargetMinutes: 30,
        leftTodayMinutes: 0,
      });
    });
  });

  test("returns the full target for another date without any logged work", async () => {
    await withTargets(120, async () => {
      expect(await listFor({ date: EMPTY_DAY })).toMatchObject({
        items: [],
        loggedTodayMinutes: 0,
        dailyTargetMinutes: 120,
        leftTodayMinutes: 120,
      });
    });
  });
});

describe("personal time entries", () => {
  test("shows only the user's accessible matters in the active organization on the requested date", async () => {
    const result = await listFor({ date: DAY });
    if (!isPage(result)) {
      throw new Error(`unexpected list response: ${JSON.stringify(result)}`);
    }

    expect(result.items).toHaveLength(visibleIds.length);
    expect(result.items.map(({ id }) => id)).toEqual(
      expect.arrayContaining([...visibleIds]),
    );
    expect(result.items.map(({ workspaceId }) => workspaceId)).toEqual(
      expect.arrayContaining([ids.wsA1, ids.wsA2]),
    );
    expect(result.items.map(({ workspaceName }) => workspaceName)).toEqual(
      expect.arrayContaining(["WS A1", "WS A2"]),
    );
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
    expect(page.loggedTodayMinutes).toBe(97);
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
      withTimeBillingEnrolment(
        asTestRaw<ListCtx>({
          query: { date: DAY },
          request: new Request("https://example.test/time-entries/me"),
          route: "/time-entries/me",
          safeDb: createSafeDb(testDb, [], ids.orgA, ids.userA1),
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          memberRole: sessionMemberRole("member"),
        }),
      ),
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
