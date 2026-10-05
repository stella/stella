import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimers,
  workspaces,
  workspaceMembers,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

import createInvoice from "./create";
import deleteInvoice from "./delete";
import addEntries from "./entries/add";
import removeEntries from "./entries/remove";
import createLine from "./lines/create";
import deleteLine from "./lines/delete";
import transitionInvoice from "./transition";

setDefaultTimeout(120_000);
const ids = createTestIds();
let db: TestDatabase;
const auditEvents: AuditEvent[] = [];
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);

  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA2, ids.userAdmin]));
  await db
    .insert(featureEnrolments)
    .values([
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
  await db.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId: ids.wsA1,
    userId: ids.userA2,
  });
});
afterAll(async () => {
  await releaseTestDb();
});
beforeEach(() => {
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  auditEvents.length = 0;
});
afterEach(async () => {
  await db.delete(timeTimers).where(eq(timeTimers.organizationId, ids.orgA));
  await db
    .update(timeEntries)
    .set({ timerStartedAt: null })
    .where(eq(timeEntries.organizationId, ids.orgA));
  setSystemTime();
});

const context = <TContext>(
  _handler: (input: TContext) => unknown,
  request: {
    body?: unknown;
    params?: unknown;
    workspaceId?: SafeId<"workspace">;
    actor?: "owner" | "member";
  },
) => {
  const workspaceId = request.workspaceId ?? ids.wsA1;
  const actor = request.actor ?? "owner";
  const actorId = actor === "member" ? ids.userA2 : ids.userAdmin;
  const recordAuditEvent = async (
    _tx: unknown,
    events: AuditEvent | AuditEvent[],
  ) => {
    auditEvents.push(...(Array.isArray(events) ? events : [events]));
  };
  return asTestRaw<TContext>({
    ...request,
    workspaceId,
    memberRole: sessionMemberRole(actor),
    session: { activeOrganizationId: ids.orgA },
    user: { id: actorId },
    safeDb: createSafeDb(db, [workspaceId], ids.orgA, actorId),
    scopedDb: createScopedDb(db, [workspaceId], ids.orgA, actorId),
    recordAuditEvent,
    createAuditRecorder: () => recordAuditEvent,
    request: new Request("https://example.test/invoices/running-time"),
    route: "/test/invoices/running-time",
  });
};

const seedInvoice = async (
  status:
    | typeof INVOICE_STATUS.DRAFT
    | typeof INVOICE_STATUS.FINALIZED = INVOICE_STATUS.DRAFT,
) => {
  const id = createSafeId<"invoice">();
  await db.insert(invoices).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber: `INV-${id}`,
    invoiceDate: "2026-09-30",
    currency: "USD",
    status,
  });
  return id;
};

type SeedRunningEntryOptions = {
  kind: "direct" | "migrated";
  owner?: "self" | "other";
  state?: "running" | "paused";
  invoiceId?: SafeId<"invoice">;
};
const seedRunningEntry = async ({
  kind,
  owner = "other",
  state = "running",
  invoiceId,
}: SeedRunningEntryOptions) => {
  const id = createSafeId<"timeEntry">();
  const userId = owner === "self" ? ids.userAdmin : ids.userA1;
  const startedAt = new Date("2026-09-30T11:57:00Z");
  await db.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId,
    workItemId: ids.entityA1,
    dateWorked: "2026-09-30",
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(20_000),
    currency: "USD",
    narrative: "Research",
    billable: true,
    status: invoiceId ? BILLING_STATUS.BILLED : BILLING_STATUS.APPROVED,
    source: TIME_ENTRY_SOURCE.TIMER,
    invoiceId: invoiceId ?? null,
    timerStartedAt: kind === "direct" ? startedAt : null,
    timerStoppedAt: null,
  });
  if (kind === "migrated") {
    await db.insert(timeTimers).values({
      id: createSafeId<"timeTimer">(),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId,
      legacyTimeEntryId: id,
      description: "Research",
      state,
      startedAt,
      lastResumedAt: state === "running" ? startedAt : null,
      accumulatedSeconds: 0,
    });
  }
  return id;
};

const seedTimeLine = async (
  invoiceId: SafeId<"invoice">,
  timeEntryId: SafeId<"timeEntry">,
) => {
  const id = createSafeId<"invoiceLine">();
  await db.insert(invoiceLines).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceId,
    position: 0,
    description: "Research",
    quantity: "1",
    unitPrice: cents(20_000),
    vatRateBps: 0,
    vatTreatment: "domestic_vat",
    netAmount: cents(20_000),
    vatAmount: cents(0),
    grossAmount: cents(20_000),
    source: "time_entry",
    timeEntryId,
  });
  return id;
};

const readState = async () =>
  await Promise.all([
    db.select().from(invoices).where(eq(invoices.workspaceId, ids.wsA1)),
    db
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.organizationId, ids.orgA)),
    db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.organizationId, ids.orgA)),
    db.select().from(timeTimers).where(eq(timeTimers.workspaceId, ids.wsA1)),
  ]);

type InvoiceClaimOptions = {
  actor?: "owner" | "member";
  invoiceId: SafeId<"invoice">;
  entryId: SafeId<"timeEntry">;
};
const claimOperations = [
  {
    name: "create invoice",
    run: async ({ entryId, actor = "owner" }: InvoiceClaimOptions) =>
      await createInvoice.handler(
        context(createInvoice.handler, {
          actor,
          body: {
            invoiceNumber: `NEW-${entryId}`,
            invoiceDate: "2026-09-30",
            currency: "USD",
            timeEntryIds: [entryId],
          },
        }),
      ),
  },
  {
    name: "add entries",
    run: async ({ invoiceId, entryId, actor = "owner" }: InvoiceClaimOptions) =>
      await addEntries.handler(
        context(addEntries.handler, {
          actor,
          params: { workspaceId: ids.wsA1, invoiceId },
          body: { timeEntryIds: [entryId] },
        }),
      ),
  },
  {
    name: "add time line",
    run: async ({ invoiceId, entryId, actor = "owner" }: InvoiceClaimOptions) =>
      await createLine.handler(
        context(createLine.handler, {
          actor,
          params: { workspaceId: ids.wsA1, invoiceId },
          body: {
            source: { type: "time_entry", timeEntryId: entryId },
            vatRateBps: 0,
            vatTreatment: "domestic_vat",
          },
        }),
      ),
  },
];

type InvoiceReleaseOptions = InvoiceClaimOptions & {
  lineId: SafeId<"invoiceLine">;
};
const releaseOperations = [
  {
    name: "delete invoice",
    status: INVOICE_STATUS.DRAFT,
    run: async ({ invoiceId, actor = "owner" }: InvoiceReleaseOptions) =>
      await deleteInvoice.handler(
        context(deleteInvoice.handler, {
          actor,
          params: { workspaceId: ids.wsA1, invoiceId },
        }),
      ),
  },
  {
    name: "void invoice",
    status: INVOICE_STATUS.FINALIZED,
    run: async ({ invoiceId, actor = "owner" }: InvoiceReleaseOptions) =>
      await transitionInvoice.handler(
        context(transitionInvoice.handler, {
          actor,
          params: { workspaceId: ids.wsA1, invoiceId },
          body: { action: "void" },
        }),
      ),
  },
  {
    name: "remove entries",
    status: INVOICE_STATUS.DRAFT,
    run: async ({
      invoiceId,
      entryId,
      actor = "owner",
    }: InvoiceReleaseOptions) =>
      await removeEntries.handler(
        context(removeEntries.handler, {
          actor,
          params: { workspaceId: ids.wsA1, invoiceId },
          body: { timeEntryIds: [entryId] },
        }),
      ),
  },
  {
    name: "delete time line",
    status: INVOICE_STATUS.DRAFT,
    run: async ({
      invoiceId,
      lineId,
      actor = "owner",
    }: InvoiceReleaseOptions) =>
      await deleteLine.handler(
        context(deleteLine.handler, {
          actor,
          params: { workspaceId: ids.wsA1, invoiceId, lineId },
        }),
      ),
  },
] as const;

const claimCases = (["direct", "migrated"] as const).flatMap((kind) =>
  claimOperations.map((operation) => ({
    kind,
    name: operation.name,
    run: operation.run,
  })),
);
const releaseCases = (["direct", "migrated"] as const).flatMap((kind) =>
  releaseOperations.map((operation) => ({
    kind,
    name: operation.name,
    run: operation.run,
    status: operation.status,
  })),
);

describe("invoice mutations respect running time ownership", () => {
  test.each(claimCases)(
    "plain member $name refuses a colleague's $kind running entry without writes",
    async ({ kind, run }) => {
      const invoiceId = await seedInvoice();
      const entryId = await seedRunningEntry({ kind });
      const before = await readState();
      expect(await run({ invoiceId, entryId, actor: "member" })).toMatchObject({
        code: 409,
        response: { code: "running_timer" },
      });
      expect(await readState()).toEqual(before);
      expect(auditEvents).toHaveLength(0);
    },
  );

  test.each(releaseCases)(
    "plain member $name refuses a colleague's $kind running billed entry without writes",
    async ({ kind, run, status }) => {
      const invoiceId = await seedInvoice(status);
      const entryId = await seedRunningEntry({ kind, invoiceId });
      const lineId = await seedTimeLine(invoiceId, entryId);
      const before = await readState();
      expect(
        await run({ invoiceId, entryId, lineId, actor: "member" }),
      ).toMatchObject({
        code: 409,
        response: { code: "running_timer" },
      });
      expect(await readState()).toEqual(before);
      expect(auditEvents).toHaveLength(0);
    },
  );

  test.each(claimOperations)(
    "plain member $name permits a colleague's paused migrated entry",
    async ({ run }) => {
      const invoiceId = await seedInvoice();
      const entryId = await seedRunningEntry({
        kind: "migrated",
        state: "paused",
      });
      expect(
        await run({ invoiceId, entryId, actor: "member" }),
      ).not.toHaveProperty("code");
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: entryId } },
        }),
      ).toMatchObject({ status: BILLING_STATUS.BILLED });
    },
  );

  test.each(releaseOperations)(
    "plain member $name permits releasing a colleague's paused migrated entry",
    async ({ run, status }) => {
      const invoiceId = await seedInvoice(status);
      const entryId = await seedRunningEntry({
        kind: "migrated",
        state: "paused",
        invoiceId,
      });
      const lineId = await seedTimeLine(invoiceId, entryId);
      expect(
        await run({ invoiceId, entryId, lineId, actor: "member" }),
      ).not.toHaveProperty("code");
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: entryId } },
        }),
      ).toMatchObject({ status: BILLING_STATUS.APPROVED, invoiceId: null });
    },
  );

  test.each(claimCases)(
    "$name refuses another member's $kind running approved entry without writes",
    async ({ kind, run }) => {
      const invoiceId = await seedInvoice();
      const entryId = await seedRunningEntry({ kind });
      const before = await readState();
      expect(await run({ invoiceId, entryId })).toMatchObject({
        code: 409,
        response: { code: "running_timer" },
      });
      expect(await readState()).toEqual(before);
      expect(auditEvents).toHaveLength(0);
    },
  );

  test.each(releaseCases)(
    "$name refuses to release another member's $kind running billed entry",
    async ({ kind, run, status }) => {
      const invoiceId = await seedInvoice(status);
      const entryId = await seedRunningEntry({ kind, invoiceId });
      const lineId = await seedTimeLine(invoiceId, entryId);
      const before = await readState();
      expect(await run({ invoiceId, entryId, lineId })).toMatchObject({
        code: 409,
        response: { code: "running_timer" },
      });
      expect(await readState()).toEqual(before);
      expect(auditEvents).toHaveLength(0);
    },
  );

  test.each(claimCases)(
    "$name preserves claiming the actor's own $kind running approved entry",
    async ({ kind, run }) => {
      const invoiceId = await seedInvoice();
      const entryId = await seedRunningEntry({ kind, owner: "self" });
      const result = await run({ invoiceId, entryId });
      expect(result).not.toHaveProperty("code");
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: entryId } },
        }),
      ).toMatchObject({ status: BILLING_STATUS.BILLED });
    },
  );

  test.each(releaseCases)(
    "$name preserves releasing the actor's own $kind running billed entry",
    async ({ kind, run, status }) => {
      const invoiceId = await seedInvoice(status);
      const entryId = await seedRunningEntry({
        kind,
        owner: "self",
        invoiceId,
      });
      const lineId = await seedTimeLine(invoiceId, entryId);
      expect(await run({ invoiceId, entryId, lineId })).not.toHaveProperty(
        "code",
      );
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: entryId } },
        }),
      ).toMatchObject({ status: BILLING_STATUS.APPROVED, invoiceId: null });
    },
  );

  test.each(["manual", "expense"] as const)(
    "deleting a %s line leaves an unrelated running time line unchanged",
    async (source) => {
      const invoiceId = await seedInvoice();
      const entryId = await seedRunningEntry({ kind: "migrated", invoiceId });
      const timeLineId = await seedTimeLine(invoiceId, entryId);
      const lineId = createSafeId<"invoiceLine">();
      const expenseId = source === "expense" ? createSafeId<"expense">() : null;
      if (expenseId) {
        await db.insert(expenses).values({
          id: expenseId,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          userId: ids.userA1,
          matterId: ids.entityA1,
          dateIncurred: "2026-09-30",
          amount: cents(100),
          currency: "USD",
          category: "filing_fee",
          description: "Court fee",
          status: BILLING_STATUS.BILLED,
          invoiceId,
        });
      }
      await db.insert(invoiceLines).values({
        id: lineId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        invoiceId,
        position: 1,
        description: "Court fee",
        quantity: "1",
        unitPrice: cents(100),
        vatRateBps: 0,
        vatTreatment: "domestic_vat",
        netAmount: cents(100),
        vatAmount: cents(0),
        grossAmount: cents(100),
        source,
        expenseId,
      });
      const entryBefore = await db.query.timeEntries.findFirst({
        where: { id: { eq: entryId } },
      });
      const lineBefore = await db.query.invoiceLines.findFirst({
        where: { id: { eq: timeLineId } },
      });
      expect(
        await deleteLine.handler(
          context(deleteLine.handler, {
            params: { workspaceId: ids.wsA1, invoiceId, lineId },
          }),
        ),
      ).toHaveProperty("id");
      expect(
        await db.query.invoiceLines.findFirst({
          where: { id: { eq: lineId } },
        }),
      ).toBeUndefined();
      expect(
        await db.query.timeEntries.findFirst({
          where: { id: { eq: entryId } },
        }),
      ).toEqual(entryBefore);
      expect(
        await db.query.invoiceLines.findFirst({
          where: { id: { eq: timeLineId } },
        }),
      ).toEqual(lineBefore);
    },
  );
});

test("concurrent invoice creation respects the final available matter slot", async () => {
  const workspaceId = createSafeId<"workspace">();
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    name: "Invoice capacity",
    reference: `CAP-${workspaceId}`,
  });
  await db.execute(sql`INSERT INTO invoices (id, organization_id, workspace_id, invoice_number, invoice_date, currency, status)
    SELECT gen_random_uuid(), ${ids.orgA}, ${workspaceId}::uuid, 'CAP-' || position, '2026-09-30'::date, 'USD', 'draft'
    FROM generate_series(1, ${LIMITS.invoicesPerWorkspace - 1}) AS position`);
  const entryIds = [createSafeId<"timeEntry">(), createSafeId<"timeEntry">()];
  await db.insert(timeEntries).values(
    entryIds.map((id) => ({
      id,
      organizationId: ids.orgA,
      workspaceId,
      userId: ids.userAdmin,
      dateWorked: "2026-09-30",
      timezoneId: "UTC",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: cents(20_000),
      currency: "USD",
      narrative: "Research",
      billable: true,
      status: BILLING_STATUS.APPROVED,
    })),
  );
  expect(await db.$count(invoices, eq(invoices.workspaceId, workspaceId))).toBe(
    LIMITS.invoicesPerWorkspace - 1,
  );
  const bothStarted = Promise.withResolvers();
  let startedCount = 0;
  const realSafeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [workspaceId], ids.orgA, ids.userAdmin),
  );
  // Synchronize competing requests at transaction admission, since eligibility
  // is now checked inside the guarded transaction rather than in a preflight.
  const safeDb: SafeDb = async (run, retry) => {
    startedCount += 1;
    if (startedCount === 2) {
      bothStarted.resolve(undefined);
    }
    await bothStarted.promise;
    return await realSafeDb(run, retry);
  };
  const results = await Promise.all(
    entryIds.map(
      async (entryId) =>
        await createInvoice.handler({
          ...context(createInvoice.handler, {
            workspaceId,
            body: {
              invoiceNumber: `NEW-${entryId}`,
              invoiceDate: "2026-09-30",
              currency: "USD",
              timeEntryIds: [entryId],
            },
          }),
          // Admission is resolved up front so only the guarded creation reaches safeDb.
          featureAccessSnapshot: enrolledTimeBillingSnapshot({
            userId: ids.userAdmin,
            organizationId: ids.orgA,
          }),
          safeDb,
        }),
    ),
  );
  expect(startedCount).toBe(2);
  expect(results.filter((result) => "id" in result)).toHaveLength(1);
  expect(results.filter((result) => "code" in result)).toEqual([
    expect.objectContaining({
      code: 400,
      response: { message: "Invoice limit reached for this workspace" },
    }),
  ]);
  expect(await db.$count(invoices, eq(invoices.workspaceId, workspaceId))).toBe(
    LIMITS.invoicesPerWorkspace,
  );
  const remaining = await db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.workspaceId, workspaceId));
  expect(
    remaining.filter((entry) => entry.status === BILLING_STATUS.BILLED),
  ).toHaveLength(1);
  expect(
    remaining.filter(
      (entry) =>
        entry.status === BILLING_STATUS.APPROVED && entry.invoiceId === null,
    ),
  ).toHaveLength(1);
});
