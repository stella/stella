import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { BILLING_STATUS, TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { user as authUser } from "@/api/db/auth-schema";
import {
  auditLogs,
  organizationSettings,
  timeEntries,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { AUDIT_ACTION, createAuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { DEFAULT_TIME_POLICY } from "@/api/lib/billing-time";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createInternal from "./create";

setDefaultTimeout(120_000);
type CreateCtx = Parameters<typeof createInternal.handler>[0];
let db: TestDatabase;
let ids: TestIds;
const createdIds: SafeId<"timeEntry">[] = [];
const DAY = Temporal.Now.plainDateISO("UTC").subtract({ days: 1 }).toString();
const CHECK_VIOLATION = "23514";
const validEntry = {
  activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
  workspaceId: null,
  dateWorked: DAY,
  timezoneId: "UTC",
  durationMinutes: 37,
  billedMinutes: 0,
  rateAtEntry: cents(0),
  currency: UNPRICED_TIME_ENTRY_CURRENCY,
  narrative: "Internal work",
  billable: false,
  noCharge: false,
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;

  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1]));
  await db
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});
const cleanup = async () => {
  if (createdIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.resourceId, createdIds));
    await db
      .delete(timeEntries)
      .where(inArray(timeEntries.id, createdIds.splice(0)));
  }
  await db
    .update(organizationSettings)
    .set(DEFAULT_TIME_POLICY)
    .where(eq(organizationSettings.organizationId, ids.orgA));
};
beforeEach(cleanup);
afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await releaseRlsFixture();
  }
});

const createFor = async (body: CreateCtx["body"]) => {
  const request = new Request("https://example.test/time-entries/internal");
  const result = await createInternal.handler(
    asTestRaw<CreateCtx>({
      body,
      request,
      route: "/time-entries/internal",
      safeDb: createSafeDb(db, [], ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("member"),
      recordAuditEvent: createAuditRecorder({
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceId: null,
        request,
        server: null,
      }),
    }),
  );
  if ("id" in result) {
    createdIds.push(result.id);
  }
  return result;
};
const body = {
  dateWorked: DAY,
  timezoneId: "UTC",
  durationMinutes: 37,
  narrative: "Internal work",
};
const seed = async (organizationId = ids.orgA, userId = ids.userA1) => {
  const id = createSafeId<"timeEntry">();
  await db
    .insert(timeEntries)
    .values({ ...validEntry, id, organizationId, userId });
  createdIds.push(id);
  return id;
};
const stored = async (id: SafeId<"timeEntry">) =>
  await db.query.timeEntries.findFirst({ where: { id: { eq: id } } });

describe("internal time creation", () => {
  test("records the authenticated owner's work without matter access or effective rates and audits its zero financial value", async () => {
    await db
      .update(organizationSettings)
      .set({ timeMinimumUnitMinutes: 6 })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    const before = new Date();
    const result = await createFor(body);
    if (!("id" in result)) {
      throw new Error(
        `unexpected internal creation: ${JSON.stringify(result)}`,
      );
    }
    expect(result.activityGroup).toBe(TIME_ENTRY_ACTIVITY_GROUP.INTERNAL);
    expect(await stored(result.id)).toMatchObject({
      organizationId: ids.orgA,
      userId: ids.userA1,
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      workspaceId: null,
      approverUserId: null,
      workItemId: null,
      durationMinutes: 37,
      billedMinutes: 0,
      rateAtEntry: cents(0),
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      billable: false,
      noCharge: false,
      invoiceId: null,
      invoiceNarrative: null,
      taskCode: null,
      activityCode: null,
      approvedByUserId: null,
      approvedAt: null,
      status: BILLING_STATUS.DRAFT,
    });
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, result.id));
    expect(logs).toHaveLength(1);
    expect(logs.at(0)).toMatchObject({
      action: AUDIT_ACTION.CREATE,
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceId: null,
      resourceId: result.id,
    });
    expect(logs.at(0)?.createdAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
  });

  test("monthly locks, entry age, narrative policy, and calendar validation apply before insertion", async () => {
    const date = Temporal.PlainDate.from(DAY);
    await db
      .update(organizationSettings)
      .set({
        timeLockedThroughMonth: date.with({ day: date.daysInMonth }).toString(),
      })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(await createFor(body)).toMatchObject({
      code: 400,
      response: { code: "time_period_locked" },
    });
    await db
      .update(organizationSettings)
      .set({
        timeLockedThroughMonth: null,
        timeEditWindowDays: 2,
        timeNarrativeRequired: true,
      })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(
      await createFor({
        ...body,
        dateWorked: date.subtract({ days: 3 }).toString(),
      }),
    ).toMatchObject({ code: 400, response: { code: "outside_edit_window" } });
    expect(await createFor({ ...body, narrative: " \t\n " })).toMatchObject({
      code: 400,
      response: { code: "narrative_required" },
    });
    expect(
      await createFor({ ...body, dateWorked: "2026-02-30" }),
    ).toMatchObject({ code: 400, response: { code: "invalid_date_worked" } });
    expect(createdIds).toHaveLength(0);
  });
});

describe("internal shape constraints", () => {
  const invalidChanges = [
    { label: "matter", change: () => ({ workspaceId: ids.wsA1 }) },
    { label: "billable", change: () => ({ billable: true }) },
    { label: "no charge", change: () => ({ noCharge: true }) },
    { label: "billed minutes", change: () => ({ billedMinutes: 1 }) },
    { label: "rate", change: () => ({ rateAtEntry: cents(1) }) },
    { label: "priced currency", change: () => ({ currency: "USD" }) },
    { label: "invoice", change: () => ({ invoiceId: ids.invoiceA1 }) },
    { label: "work item", change: () => ({ workItemId: ids.entityA1 }) },
    { label: "task code", change: () => ({ taskCode: "L100" }) },
    { label: "activity code", change: () => ({ activityCode: "A100" }) },
    {
      label: "invoice narrative",
      change: () => ({ invoiceNarrative: "Invoice text" }),
    },
    {
      label: "billed status",
      change: () => ({ status: BILLING_STATUS.BILLED }),
    },
    {
      label: "written-off status",
      change: () => ({ status: BILLING_STATUS.WRITTEN_OFF }),
    },
    {
      label: "client without matter",
      change: () => ({ activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT }),
    },
  ] satisfies {
    label: string;
    change: () => Partial<typeof timeEntries.$inferInsert>;
  }[];
  test.each(invalidChanges)(
    "rejects $label on an otherwise valid internal row",
    async ({ change }) => {
      const id = await seed();
      expect(await stored(id)).toMatchObject(validEntry);
      const outcome = await Result.tryPromise(
        async () =>
          await db.transaction(
            async (tx) =>
              await tx
                .update(timeEntries)
                .set(change())
                .where(eq(timeEntries.id, id)),
          ),
      );
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(isPgError(outcome.error, CHECK_VIOLATION)).toBe(true);
      }
      expect(await stored(id)).toMatchObject(validEntry);
    },
  );
  test("rejects activity groups outside the canonical domain at the SQL boundary", async () => {
    const id = await seed();
    const outcome = await Result.tryPromise(
      async () =>
        await db.transaction(
          async (tx) =>
            await tx.execute(
              sql`UPDATE ${timeEntries} SET activity_group = 'other' WHERE ${timeEntries.id} = ${id}`,
            ),
        ),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(isPgError(outcome.error, CHECK_VIOLATION)).toBe(true);
    }
    expect((await stored(id))?.activityGroup).toBe(
      TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
    );
  });
});

describe("internal row write isolation", () => {
  test("UPDATE WITH CHECK refuses moving the owner's row to an inaccessible matter or another tenant", async () => {
    const id = await seed(ids.orgA, ids.userA2);
    const scoped = createScopedDb(db, [ids.wsA2], ids.orgA, ids.userA2);
    const inaccessible = await Result.tryPromise(
      async () =>
        await scoped(
          async (tx) =>
            await tx
              .update(timeEntries)
              .set({
                activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
                workspaceId: ids.wsA1,
              })
              .where(eq(timeEntries.id, id)),
        ),
    );
    expect(inaccessible.isErr()).toBe(true);
    if (inaccessible.isErr()) {
      expect(
        isPgError(inaccessible.error, PG_ERROR.INSUFFICIENT_PRIVILEGE),
      ).toBe(true);
    }
    const foreign = await Result.tryPromise(
      async () =>
        await scoped(
          async (tx) =>
            await tx
              .update(timeEntries)
              .set({ organizationId: ids.orgB })
              .where(eq(timeEntries.id, id)),
        ),
    );
    expect(foreign.isErr()).toBe(true);
    if (foreign.isErr()) {
      expect(isPgError(foreign.error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(
        true,
      );
    }
    expect(await stored(id)).toMatchObject({
      organizationId: ids.orgA,
      workspaceId: null,
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
    });
  });

  test("another member and another tenant cannot mutate internal rows, even with a supplied row id", async () => {
    const own = await seed();
    const foreign = await seed(ids.orgB, ids.userB1);
    const scoped = createScopedDb(db, [], ids.orgA, ids.userA2);
    expect(
      await scoped(
        async (tx) =>
          await tx
            .update(timeEntries)
            .set({ narrative: "unauthorized" })
            .where(inArray(timeEntries.id, [own, foreign]))
            .returning({ id: timeEntries.id }),
      ),
    ).toEqual([]);
    expect((await stored(own))?.narrative).toBe(validEntry.narrative);
    expect((await stored(foreign))?.narrative).toBe(validEntry.narrative);
  });
});
