import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, isSQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { TimeEntryStatus } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { user as authUser } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  featureEnrolments,
  organizationSettings,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import prefillInvoice from "@/api/handlers/invoices/prefill";
import approve from "@/api/handlers/time-entries/approval-queue/approve";
import list from "@/api/handlers/time-entries/approval-queue/list";
import returnEntry from "@/api/handlers/time-entries/approval-queue/return";
import listMyTimeEntries from "@/api/handlers/time-entries/me/list";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import submit from "./create";

type SubmitCtx = Parameters<typeof submit.handler>[0];
type ApproveCtx = Parameters<typeof approve.handler>[0];
type ListCtx = Parameters<typeof list.handler>[0];
type ReturnCtx = Parameters<typeof returnEntry.handler>[0];
type MyListCtx = Parameters<typeof listMyTimeEntries.handler>[0];
type PrefillCtx = Parameters<typeof prefillInvoice.handler>[0];
type Role = "member" | "owner";

let db: TestDatabase;
let ids: TestIds;
const entryIds: SafeId<"timeEntry">[] = [];
const TODAY = Temporal.Now.plainDateISO("UTC");
const DAY = TODAY.subtract({ days: 1 }).toString();
const BEFORE_DAY = TODAY.subtract({ days: 2 }).toString();
// The last day of the previous month: a lock through that month covers it.
const LOCKED_DAY = TODAY.with({ day: 1 }).subtract({ days: 1 }).toString();

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
    .values(
      [ids.userA1, ids.userA2, ids.userAdmin].map((userId) => ({
        organizationId: ids.orgA,
        userId,
        featureId: "time-billing",
      })),
    )
    .onConflictDoNothing();
});

const cleanup = async () => {
  if (entryIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.resourceId, entryIds));
    await db
      .delete(timeEntries)
      .where(inArray(timeEntries.id, entryIds.splice(0)));
  }
  await db
    .update(organizationSettings)
    .set({ timeLockedThroughMonth: null, timeNarrativeRequired: false })
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
    durationMinutes: 30,
    billedMinutes: 30,
    rateAtEntry: cents(120_000),
    currency: "USD",
    narrative: "Reviewed the supply agreement",
    ...overrides,
  });
  entryIds.push(id);
  return id;
};

const context = (actor: SafeId<"user">, role: Role = "member") => {
  const request = new Request("https://example.test/v1/time-entries");
  const recorder = createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId: null,
    userId: actor,
    request,
    server: null,
  });
  return withTimeBillingEnrolment({
    request,
    route: "/v1/time-entries/me/submissions",
    session: { activeOrganizationId: ids.orgA },
    user: { id: actor },
    memberRole: sessionMemberRole(role),
    safeDb: createSafeDb(db, [ids.wsA2], ids.orgA, actor),
    scopedDb: createScopedDb(db, [ids.wsA2], ids.orgA, actor),
    getActiveWorkspaceIds: async () => [ids.wsA2],
    recordAuditEvent: recorder,
    createAuditRecorder: () => recorder,
  });
};

const submitFor = async (
  actor: SafeId<"user">,
  {
    startDate = DAY,
    endDate = DAY,
    approveOwn = false,
    role = "member",
  }: {
    startDate?: string;
    endDate?: string;
    approveOwn?: boolean;
    role?: Role;
  } = {},
) =>
  await submit.handler(
    asTestRaw<SubmitCtx>({
      ...context(actor, role),
      body: { startDate, endDate, approve: approveOwn },
    }),
  );

const approveFor = async (
  selected: SafeId<"timeEntry">[],
  actor: SafeId<"user">,
  role: Role = "member",
) =>
  await approve.handler(
    asTestRaw<ApproveCtx>({ ...context(actor, role), body: { ids: selected } }),
  );

const queueFor = async (actor: SafeId<"user">, role: Role = "member") =>
  await list.handler(
    asTestRaw<ListCtx>({ ...context(actor, role), query: {} }),
  );

const statusOf = async (id: SafeId<"timeEntry">) =>
  (await db.query.timeEntries.findFirst({ where: { id: { eq: id } } }))?.status;

const statusesOf = async (entries: Record<string, SafeId<"timeEntry">>) => {
  const rows = await db
    .select({ id: timeEntries.id, status: timeEntries.status })
    .from(timeEntries)
    .where(inArray(timeEntries.id, Object.values(entries)));
  const byId = new Map(rows.map(({ id, status }) => [id, status]));
  const statuses: Record<string, TimeEntryStatus | undefined> = {};
  for (const [name, id] of Object.entries(entries)) {
    statuses[name] = byId.get(id);
  }
  return statuses;
};

describe("submitting a week", () => {
  test("submits each ready draft and refuses the rest with their reasons", async () => {
    await db
      .update(organizationSettings)
      .set({ timeNarrativeRequired: true })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    const entries = {
      ready: await seedEntry(),
      unpriced: await seedEntry({
        currency: UNPRICED_TIME_ENTRY_CURRENCY,
        rateAtEntry: cents(0),
      }),
      noNarrative: await seedEntry({ narrative: "  " }),
      running: await seedEntry({
        timerStartedAt: new Date(`${DAY}T09:00:00Z`),
      }),
      alreadyApproved: await seedEntry({
        status: "approved",
        approvedByUserId: ids.userA2,
        approvedAt: new Date(),
      }),
      someoneElses: await seedEntry({ userId: ids.userA2 }),
      dayBefore: await seedEntry({ dateWorked: BEFORE_DAY }),
    };

    const outcome = await submitFor(ids.userA1);
    if (!("results" in outcome)) {
      throw new Error(`unexpected submit outcome: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.results.toSorted((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
      [
        { id: entries.ready, status: "submitted" },
        { id: entries.unpriced, status: "refused", reason: "unpriced" },
        {
          id: entries.noNarrative,
          status: "refused",
          reason: "narrative_required",
        },
        { id: entries.running, status: "refused", reason: "running_timer" },
      ].toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(await statusesOf(entries)).toEqual({
      ready: "submitted",
      unpriced: "draft",
      noNarrative: "draft",
      running: "draft",
      alreadyApproved: "approved",
      someoneElses: "draft",
      dayBefore: "draft",
    });
  });

  test("refuses drafts in a locked month and caps the range at a week", async () => {
    const locked = await seedEntry({ dateWorked: LOCKED_DAY });
    await db
      .update(organizationSettings)
      .set({ timeLockedThroughMonth: LOCKED_DAY })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(
      await submitFor(ids.userA1, {
        startDate: LOCKED_DAY,
        endDate: LOCKED_DAY,
      }),
    ).toEqual({
      results: [
        { id: locked, status: "refused", reason: "time_period_locked" },
      ],
    });
    expect(await statusOf(locked)).toBe("draft");
    const start = Temporal.PlainDate.from(DAY).subtract({ days: 7 });
    expect(
      await submitFor(ids.userA1, { startDate: start.toString() }),
    ).toMatchObject({ code: 400, response: { code: "invalid_date_range" } });
  });
});

// Runs `edit` in the submit's own transaction just before its guarded write,
// as a concurrent edit committed between the submit's read and its write
// would look to that write.
const safeDbEditingBeforeWrite = (
  actor: SafeId<"user">,
  edit: (tx: Transaction) => Promise<unknown>,
) => {
  const base = createSafeDb(db, [ids.wsA2], ids.orgA, actor);
  const dialect = new PgDialect();
  let pending = true;
  const isSubmitWrite = (query: unknown) =>
    isSQLWrapper(query) &&
    /^\s*UPDATE "time_entries"/u.test(dialect.sqlToQuery(query.getSQL()).sql);
  return asTestRaw<SafeDb>(
    async (
      run: (tx: Transaction) => Promise<unknown>,
      retry?: Parameters<SafeDb>[1],
    ) =>
      await base(
        async (tx) =>
          await run(
            new Proxy(tx, {
              get: (target, property) => {
                const value: unknown = Reflect.get(target, property, target);
                if (typeof value !== "function") {
                  return value;
                }
                if (property !== "execute") {
                  return value.bind(target);
                }
                return async (query: unknown) => {
                  if (pending && isSubmitWrite(query)) {
                    pending = false;
                    await edit(target);
                  }
                  return await Reflect.apply(value, target, [query]);
                };
              },
            }),
          ),
        retry,
      ),
  );
};

describe("a draft edited between the submit's read and its write", () => {
  test("is refused with its current reason, not submitted", async () => {
    await db
      .update(organizationSettings)
      .set({ timeNarrativeRequired: true })
      .where(eq(organizationSettings.organizationId, ids.orgA));
    const edited = await seedEntry();
    const untouched = await seedEntry({ narrative: "Drafted the lease" });
    const outcome = await submit.handler(
      asTestRaw<SubmitCtx>({
        ...context(ids.userA1),
        safeDb: safeDbEditingBeforeWrite(ids.userA1, async (tx) =>
          tx
            .update(timeEntries)
            .set({ narrative: "   " })
            .where(eq(timeEntries.id, edited)),
        ),
        body: { startDate: DAY, endDate: DAY, approve: false },
      }),
    );
    if (!("results" in outcome)) {
      throw new Error(`unexpected submit outcome: ${JSON.stringify(outcome)}`);
    }
    // The edit happened after the read saw a description.
    expect(outcome.results.toSorted((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
      [
        { id: untouched, status: "submitted" },
        { id: edited, status: "refused", reason: "narrative_required" },
      ].toSorted((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(await statusOf(edited)).toBe("draft");
    expect(await statusOf(untouched)).toBe("submitted");
  });
});

describe("the approval queue", () => {
  test("lists submitted entries only, with names, rate and a pending count", async () => {
    const submitted = await seedEntry({ status: "submitted" });
    await seedEntry({ narrative: "Still being written" });
    const queue = await queueFor(ids.userA2);
    if (!("items" in queue)) {
      throw new Error(`unexpected queue: ${JSON.stringify(queue)}`);
    }
    expect(queue.items.map(({ id }) => id)).toEqual([submitted]);
    expect(queue.pendingCount).toBe(1);
    expect(queue.items[0]).toMatchObject({
      status: "submitted",
      matterName: "WS A2",
      rateAtEntry: 120_000,
      currency: "USD",
      timekeeperName: expect.any(String),
    });
  });
});

describe("approving a draft directly", () => {
  test("is refused for someone else's draft, even to an admin", async () => {
    const draft = await seedEntry();
    expect(await approveFor([draft], ids.userAdmin, "owner")).toEqual({
      results: [{ id: draft, status: "refused", reason: "not_submitted" }],
    });
    expect(await approveFor([draft], ids.userA2)).toEqual({
      results: [{ id: draft, status: "refused", reason: "not_submitted" }],
    });
    expect(await statusOf(draft)).toBe("draft");
  });

  test("is the solo path: an approver submits and approves their own week at once", async () => {
    const own = await seedEntry({ userId: ids.userAdmin });
    expect(
      await submitFor(ids.userAdmin, { approveOwn: true, role: "owner" }),
    ).toEqual({ results: [{ id: own, status: "approved" }] });
    expect(await statusOf(own)).toBe("approved");

    const ownDraft = await seedEntry({ userId: ids.userAdmin });
    expect(await approveFor([ownDraft], ids.userAdmin, "owner")).toEqual({
      results: [{ id: ownDraft, status: "approved" }],
    });
  });

  test("a timekeeper who is not the approver only submits when asking to approve", async () => {
    const draft = await seedEntry();
    expect(await submitFor(ids.userA1, { approveOwn: true })).toEqual({
      results: [{ id: draft, status: "submitted" }],
    });
  });
});

describe("returning a submitted entry", () => {
  test("puts it back to draft with the reason the timekeeper sees on their week", async () => {
    const id = await seedEntry({ status: "submitted" });
    expect(
      await returnEntry.handler(
        asTestRaw<ReturnCtx>({
          ...context(ids.userA2),
          body: { id, comment: "Split the call from the drafting" },
        }),
      ),
    ).toEqual({ id, status: "draft" });
    const mine = await listMyTimeEntries.handler(
      asTestRaw<MyListCtx>({
        ...context(ids.userA1),
        query: { date: DAY },
      }),
    );
    if (!("items" in mine)) {
      throw new Error(`unexpected list: ${JSON.stringify(mine)}`);
    }
    expect(mine.items.find((item) => item.id === id)).toMatchObject({
      status: "draft",
      returnComment: "Split the call from the drafting",
    });
  });
});

describe("invoice prefill", () => {
  test("bills approved entries only, never submitted ones", async () => {
    const approved = await seedEntry({
      status: "approved",
      approvedByUserId: ids.userA2,
      approvedAt: new Date(),
    });
    const submitted = await seedEntry({ status: "submitted" });
    const prefill = await prefillInvoice.handler(
      asTestRaw<PrefillCtx>({
        ...context(ids.userA1, "owner"),
        params: { workspaceId: ids.wsA2 },
        query: {},
        workspaceId: ids.wsA2,
        getWorkspaceAccess: async () => ({ id: ids.wsA2, status: "active" }),
        getAccessibleWorkspaces: async () => [
          { id: ids.wsA2, status: "active" },
        ],
        orgAIConfig: null,
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        promptCachingEnabled: false,
      }),
    );
    const prefilled = JSON.stringify(prefill);
    expect(prefilled).toContain(approved);
    expect(prefilled).not.toContain(submitted);
  });
});
