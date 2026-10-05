import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { pgTable, text, integer, boolean } from "drizzle-orm/pg-core";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import type { PermissionInput } from "@stll/permissions";
import { Temporal } from "@stll/time";

import { user as authUser } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  billingArrangements,
  organizationSettings,
  timeEntries,
  timeTimers,
  workspaces,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { DEFAULT_TIME_POLICY } from "@/api/lib/billing-time";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import {
  authorizedMemberRole,
  roleForDisplay,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { withTenantActionSizePolicy } from "@/api/lib/rate-limit/action-size-limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import updateTimeEntry from "../update";
import approve from "./approve";
import list from "./list";
import returnEntry from "./return";

setDefaultTimeout(120_000);
type ApproveCtx = Parameters<typeof approve.handler>[0];
type ListCtx = Parameters<typeof list.handler>[0];
type ReturnCtx = Parameters<typeof returnEntry.handler>[0];
type UpdateCtx = Parameters<typeof updateTimeEntry.handler>[0];
let db: TestDatabase;
let ids: TestIds;
const entryIds: SafeId<"timeEntry">[] = [];
const capWorkspaceIds: SafeId<"workspace">[] = [];
const timerIds: SafeId<"timeTimer">[] = [];
const DAY = Temporal.Now.plainDateISO("UTC").subtract({ days: 1 }).toString();
const START = new Date(`${DAY}T10:00:00Z`);

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;

  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1, ids.userA2, ids.userAdmin]));
  await db
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgA,
        userId: ids.userA2,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgA,
        userId: ids.userAdmin,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});

const cleanup = async () => {
  if (timerIds.length) {
    await db
      .delete(timeTimers)
      .where(inArray(timeTimers.id, timerIds.splice(0)));
  }
  if (entryIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.resourceId, entryIds));
    await db
      .delete(timeEntries)
      .where(inArray(timeEntries.id, entryIds.splice(0)));
  }
  if (capWorkspaceIds.length) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.workspaceId, capWorkspaceIds));
    await db
      .delete(workspaces)
      .where(inArray(workspaces.id, capWorkspaceIds.splice(0)));
  }
  await db
    .update(organizationSettings)
    .set({ timeLockedThroughMonth: null })
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

const seedEntry = async (
  overrides: Partial<Omit<typeof timeEntries.$inferInsert, "id">> = {},
) => {
  const id = createSafeId<"timeEntry">();
  await db.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
    approverUserId: ids.userA2,
    dateWorked: DAY,
    timezoneId: "UTC",
    durationMinutes: 37,
    billedMinutes: 42,
    rateAtEntry: cents(0),
    currency: "USD",
    narrative: "Recorded work",
    ...overrides,
  });
  entryIds.push(id);
  return id;
};

const context = (actor = ids.userA2, role: "member" | "owner" = "member") => {
  const request = new Request(
    "https://example.test/time-entries/approval-queue",
  );
  const recorder = (workspaceId: SafeId<"workspace"> | null) =>
    createAuditRecorder({
      organizationId: ids.orgA,
      workspaceId,
      userId: actor,
      request,
      server: null,
    });
  return {
    request,
    route: "/time-entries/approval-queue",
    session: { activeOrganizationId: ids.orgA },
    user: { id: actor },
    memberRole: sessionMemberRole(role),
    safeDb: createSafeDb(db, [ids.wsA2], ids.orgA, actor),
    scopedDb: createScopedDb(db, [ids.wsA2], ids.orgA, actor),
    getActiveWorkspaceIds: async () => [ids.wsA2],
    recordAuditEvent: recorder(null),
    createAuditRecorder: (options?: {
      workspaceId?: SafeId<"workspace"> | null;
    }) => recorder(options?.workspaceId ?? null),
  };
};
const approveFor = async (
  selected: SafeId<"timeEntry">[],
  actor = ids.userA2,
  role: "member" | "owner" = "member",
) =>
  await approve.handler(
    asTestRaw<ApproveCtx>({ ...context(actor, role), body: { ids: selected } }),
  );
const returnFor = async (id: SafeId<"timeEntry">, comment: string) =>
  await returnEntry.handler(
    asTestRaw<ReturnCtx>({ ...context(), body: { id, comment } }),
  );
const listFor = async (
  query: ListCtx["query"] = {},
  actor = ids.userA2,
  role: "member" | "owner" = "member",
) => await list.handler(asTestRaw<ListCtx>({ ...context(actor, role), query }));
const stored = async (id: SafeId<"timeEntry">) =>
  await db.query.timeEntries.findFirst({ where: { id: { eq: id } } });

describe("approval queue authorization", () => {
  test("an assigned member approves with server-bound actor, timestamp, and matter audit", async () => {
    const id = await seedEntry();
    const before = new Date();
    expect(await approveFor([id])).toEqual({
      results: [{ id, status: "approved" }],
    });
    const row = await stored(id);
    expect(row).toMatchObject({
      status: "approved",
      approvedByUserId: ids.userA2,
      returnedAt: null,
      returnComment: null,
    });
    expect(row?.approvedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row?.approvedAt?.getTime()).toBeLessThanOrEqual(Date.now());
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, id));
    expect(logs).toHaveLength(1);
    expect(logs.at(0)).toMatchObject({
      userId: ids.userA2,
      organizationId: ids.orgA,
      workspaceId: ids.wsA2,
    });
    expect(logs.at(0)?.createdAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(await approveFor([id])).toEqual({
      results: [{ id, status: "approved" }],
    });
    expect((await stored(id))?.approvedAt).toEqual(row?.approvedAt);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.resourceId, id)),
    ).toHaveLength(1);
  });

  test("ownership alone grants no approval and null approvers belong to the admin queue", async () => {
    const assigned = await seedEntry();
    const unassigned = await seedEntry({ approverUserId: null });
    expect(await approveFor([assigned, unassigned], ids.userA1)).toMatchObject({
      results: [
        { id: assigned, status: "refused" },
        { id: unassigned, status: "refused" },
      ],
    });
    expect((await stored(assigned))?.status).toBe("draft");
    expect(await approveFor([unassigned], ids.userAdmin, "owner")).toEqual({
      results: [{ id: unassigned, status: "approved" }],
    });
  });

  test("a batch commits eligible rows while refusing unauthorized, unavailable, and non-draft rows", async () => {
    const allowed = await seedEntry();
    const otherApprover = await seedEntry({ approverUserId: ids.userAdmin });
    const alreadyApproved = await seedEntry({ status: "written_off" });
    const foreign = await seedEntry({
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      userId: ids.userB1,
    });
    const missing = createSafeId<"timeEntry">();
    const result = await approveFor([
      allowed,
      otherApprover,
      alreadyApproved,
      foreign,
      missing,
    ]);
    if (!("results" in result)) {
      throw new Error(`unexpected approval: ${JSON.stringify(result)}`);
    }
    expect(result.results).toHaveLength(5);
    expect(result.results.find((row) => row.id === allowed)).toEqual({
      id: allowed,
      status: "approved",
    });
    for (const id of [otherApprover, alreadyApproved, foreign, missing]) {
      expect(result.results.find((row) => row.id === id)).toMatchObject({
        id,
        status: "refused",
        reason: expect.any(String),
      });
    }
    expect((await stored(foreign))?.status).toBe("draft");
    expect((await stored(otherApprover))?.status).toBe("draft");
    expect(await returnFor(otherApprover, "Please revise")).toMatchObject({
      code: 409,
    });
    expect((await stored(otherApprover))?.returnComment).toBeNull();
    expect(await returnFor(foreign, "Please revise")).toMatchObject({
      code: 404,
    });
  });
});

describe("return and reapproval lifecycle", () => {
  test("empty comments cannot reset approval, while returning clears provenance and keeps feedback until reapproval", async () => {
    const id = await seedEntry();
    await approveFor([id]);
    for (const comment of ["", "   ", "\t\n"]) {
      expect(await returnFor(id, comment)).toMatchObject({ code: 400 });
      expect((await stored(id))?.status).toBe("approved");
    }
    expect(await returnFor(id, "Please clarify the work")).toEqual({
      id,
      status: "draft",
    });
    const returned = await stored(id);
    expect(returned).toMatchObject({
      status: "draft",
      approvedByUserId: null,
      approvedAt: null,
      returnedByUserId: ids.userA2,
      returnComment: "Please clarify the work",
      returnedAt: expect.any(Date),
    });
    await updateTimeEntry.handler(
      asTestRaw<UpdateCtx>({
        ...context(ids.userA1),
        workspaceId: ids.wsA2,
        recordAuditEvent: createAuditRecorder({
          organizationId: ids.orgA,
          workspaceId: ids.wsA2,
          userId: ids.userA1,
          request: new Request("https://example.test/update"),
          server: null,
        }),
        body: { id, narrative: "Clarified work" },
      }),
    );
    expect(await stored(id)).toMatchObject({
      narrative: "Clarified work",
      returnComment: "Please clarify the work",
      returnedAt: returned?.returnedAt,
    });
    expect(await approveFor([id])).toEqual({
      results: [{ id, status: "approved" }],
    });
    expect(await stored(id)).toMatchObject({
      returnComment: null,
      returnedAt: null,
      returnedByUserId: null,
    });
  });
});

describe("approval queue pages", () => {
  test("bounds default and requested pages while retaining a continuation cursor", async () => {
    await seedEntry();
    await seedEntry();
    for (const limit of [undefined, 4]) {
      const page = await withTenantActionSizePolicy(
        { requestBytes: 512, responseBytes: 512, pageSize: 1 },
        async () =>
          await listFor({
            from: DAY,
            to: DAY,
            ...(limit === undefined ? {} : { limit }),
          }),
      );
      expect(page).toHaveProperty("items");
      if (!("items" in page)) {
        return;
      }
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
    }
  });

  test("filters assigned drafts by date, member, and matter while preserving logged and billed minutes", async () => {
    const first = await seedEntry();
    const second = await seedEntry();
    await seedEntry({ approverUserId: ids.userA1 });
    await seedEntry({ status: "approved" });
    await seedEntry({
      dateWorked: Temporal.PlainDate.from(DAY).subtract({ days: 1 }).toString(),
    });
    await seedEntry({
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      userId: ids.userB1,
    });
    const query = {
      from: DAY,
      to: DAY,
      member: ids.userA1,
      matter: ids.wsA2,
      limit: 1,
    };
    const page = await listFor(query);
    if (!("items" in page) || !page.nextCursor) {
      throw new Error(`unexpected queue page: ${JSON.stringify(page)}`);
    }
    expect(page.items).toHaveLength(1);
    expect(page.items.at(0)).toMatchObject({
      durationMinutes: 37,
      billedMinutes: 42,
      approverUserId: ids.userA2,
    });
    const next = await listFor({ ...query, cursor: page.nextCursor });
    if (!("items" in next)) {
      throw new Error(`unexpected next page: ${JSON.stringify(next)}`);
    }
    expect(next.nextCursor).toBeNull();
    expect(
      [...page.items, ...next.items].map((row) => row.id).toSorted(),
    ).toEqual([first, second].toSorted());
  });

  test("only admins include null-assignee entries", async () => {
    const id = await seedEntry({ approverUserId: null });
    expect(await listFor({ from: DAY, to: DAY })).toMatchObject({ items: [] });
    const adminPage = await listFor(
      { from: DAY, to: DAY },
      ids.userAdmin,
      "owner",
    );
    if (!("items" in adminPage)) {
      throw new Error(`unexpected admin page: ${JSON.stringify(adminPage)}`);
    }
    expect(adminPage.items.map((row) => row.id)).toContain(id);
  });
});

describe("approval lifecycle guards", () => {
  test("a locked month refuses approval and return without changing entries", async () => {
    const id = await seedEntry();
    const approvedId = await seedEntry({ status: "approved" });
    const date = Temporal.PlainDate.from(DAY);
    await db
      .update(organizationSettings)
      .set({
        timeLockedThroughMonth: date.with({ day: date.daysInMonth }).toString(),
      })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(await approveFor([id])).toMatchObject({
      results: [{ id, status: "refused", reason: "time_period_locked" }],
    });
    expect(await returnFor(approvedId, "Please revise")).toMatchObject({
      code: 409,
    });
    expect((await stored(id))?.status).toBe("draft");
    expect((await stored(approvedId))?.status).toBe("approved");
  });

  test("both private running projections and legacy running timestamps block own and other entries", async () => {
    const own = await seedEntry({ userId: ids.userA2, timerStartedAt: START });
    const other = await seedEntry({ userId: ids.userA1 });
    const timerId = createSafeId<"timeTimer">();
    await db.insert(timeTimers).values({
      id: timerId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceId: ids.wsA2,
      legacyTimeEntryId: other,
      state: "running",
      startedAt: START,
      lastResumedAt: START,
    });
    timerIds.push(timerId);
    expect(
      await createScopedDb(
        db,
        [ids.wsA2],
        ids.orgA,
        ids.userA2,
      )((tx) => tx.select().from(timeTimers)),
    ).toEqual([]);
    const result = await approveFor([own, other]);
    if (!("results" in result)) {
      throw new Error(`unexpected running result: ${JSON.stringify(result)}`);
    }
    expect(result.results).toHaveLength(2);
    expect(
      result.results.every(
        (row) => row.status === "refused" && row.reason === "running_timer",
      ),
    ).toBe(true);
    expect((await stored(own))?.status).toBe("draft");
    expect((await stored(other))?.status).toBe("draft");
  });
});

// PGlite has one backend, so verify held locks rather than starting a second transaction.
const pgLocks = pgTable("pg_locks", {
  locktype: text("locktype"),
  mode: text("mode"),
  relation: integer("relation"),
  pid: integer("pid"),
  granted: boolean("granted"),
});

describe("approval policy serialization", () => {
  const policyCheckingContext = () => {
    const ctx = context();
    const safeDb: SafeDb = async (run, retry) =>
      await asTestRaw<SafeDb>(ctx.safeDb)(async (tx) => {
        const result = await run(tx);
        const heldPolicyLocks = await tx
          .select({ mode: pgLocks.mode })
          .from(pgLocks)
          .where(
            and(
              eq(pgLocks.locktype, "relation"),
              eq(pgLocks.mode, "RowShareLock"),
              eq(pgLocks.granted, true),
              sql`${pgLocks.relation} = 'organization_settings'::regclass`,
              sql`${pgLocks.pid} = pg_backend_pid()`,
            ),
          );
        expect(heldPolicyLocks).toHaveLength(1);
        return result;
      }, retry);
    return {
      ...ctx,
      // Admission is resolved up front so every safeDb run is the policy-locked mutation.
      featureAccessSnapshot: enrolledTimeBillingSnapshot({
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
      }),
      safeDb,
    };
  };

  test("approval and return retain the month policy lock until the mutation commits", async () => {
    const id = await seedEntry();
    const approved = await approve.handler(
      asTestRaw<ApproveCtx>({
        ...policyCheckingContext(),
        body: { ids: [id] },
      }),
    );
    expect(approved).toEqual({ results: [{ id, status: "approved" }] });
    const returned = await returnEntry.handler(
      asTestRaw<ReturnCtx>({
        ...policyCheckingContext(),
        body: { id, comment: "Revise" },
      }),
    );
    expect(returned).toEqual({ id, status: "draft" });
  });

  test("an absent policy is initialized with unchanged effective defaults", async () => {
    const saved = await db.query.organizationSettings.findFirst({
      where: { organizationId: { eq: ids.orgA } },
    });
    await db
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgA));
    const id = await seedEntry();
    try {
      expect(
        await approve.handler(
          asTestRaw<ApproveCtx>({
            ...context(),
            body: { ids: [id] },
          }),
        ),
      ).toEqual({ results: [{ id, status: "approved" }] });
      const initialized = await db.query.organizationSettings.findFirst({
        where: { organizationId: { eq: ids.orgA } },
      });
      expect(initialized).toMatchObject(DEFAULT_TIME_POLICY);
    } finally {
      await db
        .delete(organizationSettings)
        .where(eq(organizationSettings.organizationId, ids.orgA));
      if (saved) {
        await db.insert(organizationSettings).values(saved);
      }
    }
  });
});

test("one approval batch reconciles each client matter independently and excludes unpriced internal work", async () => {
  const firstMatter = createSafeId<"workspace">();
  const secondMatter = createSafeId<"workspace">();
  const matters = [firstMatter, secondMatter];
  await db.insert(workspaces).values(
    matters.map((id) => ({
      id,
      organizationId: ids.orgA,
      name: "Approval cap test",
      reference: id,
    })),
  );
  capWorkspaceIds.push(...matters);
  await db.insert(billingArrangements).values([
    {
      workspaceId: firstMatter,
      organizationId: ids.orgA,
      mode: "hourly",
      currency: "USD",
      capAmount: cents(10_000),
      alertThresholdBps: 8000,
    },
    {
      workspaceId: secondMatter,
      organizationId: ids.orgA,
      mode: "hourly",
      currency: "USD",
      capAmount: cents(20_000),
      alertThresholdBps: 8000,
    },
  ]);
  const first = await seedEntry({
    workspaceId: firstMatter,
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(10_000),
    billable: true,
  });
  const second = await seedEntry({
    workspaceId: secondMatter,
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(10_000),
    billable: true,
  });
  const internal = await seedEntry({
    activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
    workspaceId: null,
    billable: false,
    noCharge: false,
    billedMinutes: 0,
    rateAtEntry: cents(0),
    currency: UNPRICED_TIME_ENTRY_CURRENCY,
  });
  const ctx = {
    ...context(ids.userAdmin, "owner"),
    safeDb: createSafeDb(db, matters, ids.orgA, ids.userAdmin),
    scopedDb: createScopedDb(db, matters, ids.orgA, ids.userAdmin),
    getActiveWorkspaceIds: async () => matters,
    body: { ids: [first, internal, second] },
  };
  expect(await approve.handler(asTestRaw<ApproveCtx>(ctx))).toEqual({
    results: [
      { id: first, status: "approved" },
      { id: internal, status: "approved" },
      { id: second, status: "approved" },
    ],
  });
  const states = await db
    .select()
    .from(billingArrangements)
    .where(inArray(billingArrangements.workspaceId, matters));
  expect(states.find((row) => row.workspaceId === firstMatter)).toMatchObject({
    capState: "above",
    thresholdState: "above",
    currencyState: "matched",
    crossingSequence: 2,
  });
  expect(states.find((row) => row.workspaceId === secondMatter)).toMatchObject({
    capState: "below",
    thresholdState: "below",
    currencyState: "matched",
    crossingSequence: 0,
  });
  const crossings = await db
    .select()
    .from(auditLogs)
    .where(inArray(auditLogs.workspaceId, matters));
  expect(
    crossings.filter(
      (row) => row.metadata?.["event"] === "billing_cap_crossed",
    ),
  ).toHaveLength(2);
  const internalAudit = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, internal));
  expect(internalAudit).toHaveLength(1);
  expect(internalAudit.at(0)).toMatchObject({ workspaceId: null });
  expect(await approve.handler(asTestRaw<ApproveCtx>(ctx))).toMatchObject({
    results: ctx.body.ids.map((id) => ({ id, status: "approved" })),
  });
  expect(
    await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.workspaceId, matters)),
  ).toHaveLength(crossings.length);
});

describe("internal work approvals", () => {
  const seedInternal = async (
    overrides: Partial<Omit<typeof timeEntries.$inferInsert, "id">> = {},
  ) =>
    await seedEntry({
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      workspaceId: null,
      billable: false,
      noCharge: false,
      billedMinutes: 0,
      rateAtEntry: cents(0),
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      ...overrides,
    });

  test("assigned approvers can list, approve, and return internal work with no matter audit attribution", async () => {
    const id = await seedInternal();
    const page = await listFor({ from: DAY, to: DAY });
    if (!("items" in page)) {
      throw new Error(`unexpected internal queue: ${JSON.stringify(page)}`);
    }
    expect(page.items).toHaveLength(1);
    expect(page.items.at(0)).toMatchObject({
      id,
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      workspaceId: null,
      durationMinutes: 37,
      billedMinutes: 0,
    });
    expect(await listFor({ matter: ids.wsA2 })).toMatchObject({ items: [] });
    expect(await approveFor([id])).toEqual({
      results: [{ id, status: "approved" }],
    });
    expect(await returnFor(id, "Clarify internal activity")).toEqual({
      id,
      status: "draft",
    });
    expect(await stored(id)).toMatchObject({
      workspaceId: null,
      billable: false,
      billedMinutes: 0,
      rateAtEntry: cents(0),
      returnComment: "Clarify internal activity",
      approvedAt: null,
    });
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, id));
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log).toMatchObject({
        userId: ids.userA2,
        organizationId: ids.orgA,
        workspaceId: null,
      });
    }
  });

  test("internal visibility stays with its owner and approvers, including admins, inside its tenant", async () => {
    const assigned = await seedInternal();
    const unassigned = await seedInternal({ approverUserId: null });
    const foreign = await seedInternal({
      organizationId: ids.orgB,
      userId: ids.userB1,
    });
    const otherMember = await createSafeDb(
      db,
      [],
      ids.orgA,
      ids.userA2,
    )((tx) =>
      tx
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(inArray(timeEntries.id, [assigned, unassigned, foreign])),
    );
    expect(otherMember.isOk() && otherMember.value).toEqual([{ id: assigned }]);
    const owner = await createSafeDb(
      db,
      [],
      ids.orgA,
      ids.userA1,
    )((tx) =>
      tx
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(inArray(timeEntries.id, [assigned, unassigned, foreign])),
    );
    expect(owner.isOk() && owner.value.map(({ id }) => id).toSorted()).toEqual(
      [assigned, unassigned].toSorted(),
    );
    expect(await approveFor([unassigned, foreign])).toMatchObject({
      results: [
        { id: unassigned, status: "refused", reason: "not_found" },
        { id: foreign, status: "refused", reason: "not_found" },
      ],
    });
    expect(await approveFor([unassigned], ids.userAdmin, "owner")).toEqual({
      results: [{ id: unassigned, status: "approved" }],
    });
    expect((await stored(foreign))?.status).toBe("draft");
  });

  test("internal approvals still refuse locked months", async () => {
    const id = await seedInternal();
    const date = Temporal.PlainDate.from(DAY);
    await db
      .update(organizationSettings)
      .set({
        timeLockedThroughMonth: date.with({ day: date.daysInMonth }).toString(),
      })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(await approveFor([id])).toMatchObject({
      results: [{ id, status: "refused", reason: "time_period_locked" }],
    });
    expect((await stored(id))?.status).toBe("draft");
  });
});

describe("approval with a credential narrowed below its owner's role", () => {
  const key = (
    role: "member" | "owner",
    permissions: PermissionInput,
  ): AuthorizedMemberRole =>
    authorizedMemberRole({
      role,
      credential: { type: "attenuated", permissions },
    });
  const approveWith = async (
    selected: SafeId<"timeEntry">[],
    actor: SafeId<"user">,
    memberRole: AuthorizedMemberRole,
  ) =>
    await approve.handler(
      asTestRaw<ApproveCtx>({
        ...context(
          actor,
          roleForDisplay(memberRole) === "owner" ? "owner" : "member",
        ),
        memberRole,
        body: { ids: selected },
      }),
    );

  test("an owner's read-only key approves nobody else's entry; the approve grant does", async () => {
    const unassigned = await seedEntry({ approverUserId: null });

    expect(
      await approveWith(
        [unassigned],
        ids.userAdmin,
        key("owner", { timeEntry: ["read"] }),
      ),
    ).toMatchObject({ results: [{ id: unassigned, status: "refused" }] });
    expect(await stored(unassigned)).toMatchObject({
      status: "draft",
      approvedByUserId: null,
    });

    expect(
      await approveWith(
        [unassigned],
        ids.userAdmin,
        key("owner", { timeEntry: ["read", "approve"] }),
      ),
    ).toEqual({ results: [{ id: unassigned, status: "approved" }] });
  });

  test("the assigned approver's key needs update to approve its own queue", async () => {
    const assigned = await seedEntry();

    expect(
      await approveWith(
        [assigned],
        ids.userA2,
        key("member", { timeEntry: ["read"] }),
      ),
    ).toMatchObject({ results: [{ id: assigned, status: "refused" }] });
    expect((await stored(assigned))?.status).toBe("draft");

    expect(
      await approveWith(
        [assigned],
        ids.userA2,
        key("member", { timeEntry: ["read", "update"] }),
      ),
    ).toEqual({ results: [{ id: assigned, status: "approved" }] });
  });
});
