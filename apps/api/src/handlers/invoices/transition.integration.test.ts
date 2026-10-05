import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  numberSeries,
  timeEntries,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import deleteInvoice from "./delete";
import transitionInvoice from "./transition";
import updateInvoice from "./update";

setDefaultTimeout(120_000);

type TransitionCtx = Parameters<typeof transitionInvoice.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

const seededInvoiceIds: SafeId<"invoice">[] = [];
const seededTimeEntryIds: SafeId<"timeEntry">[] = [];
const seededSeriesIds: SafeId<"numberSeries">[] = [];
const seededExpenseIds: SafeId<"expense">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1]));
  await testDb
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

afterAll(async () => {
  try {
    if (seededSeriesIds.length > 0) {
      await testDb
        .delete(numberSeries)
        .where(inArray(numberSeries.id, seededSeriesIds));
    }
    if (seededTimeEntryIds.length > 0) {
      await testDb
        .delete(timeEntries)
        .where(inArray(timeEntries.id, seededTimeEntryIds));
    }
    if (seededExpenseIds.length > 0) {
      await testDb
        .delete(expenses)
        .where(inArray(expenses.id, seededExpenseIds));
    }
    if (seededInvoiceIds.length > 0) {
      await testDb
        .delete(invoices)
        .where(inArray(invoices.id, seededInvoiceIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("invoice transition integration", () => {
  test("finalizes a draft invoice and rejects a repeated finalize", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });

    const firstResult = await runTransition(invoiceId, "finalize");
    const secondResult = await runTransition(invoiceId, "finalize");

    expect(firstResult).toEqual({ id: invoiceId });
    expect(secondResult).toEqual({
      code: 409,
      response: { message: "Cannot finalize invoice from its current status" },
    });
    expect(await readInvoiceStatus(invoiceId)).toBe(INVOICE_STATUS.FINALIZED);
  });

  test("allocates consecutive default-series numbers and keeps the first through revert and refinalize", async () => {
    const seriesId = createSafeId<"numberSeries">();
    seededSeriesIds.push(seriesId);
    await testDb.insert(numberSeries).values({
      id: seriesId,
      organizationId: ids.orgA,
      documentType: "invoice",
      name: "Default invoices",
      pattern: "AUTO-{YYYY}-{SEQ}",
      padding: 3,
      isDefault: true,
    });
    const first = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: null,
    });
    const second = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: null,
    });
    expect(await runTransition(first, "finalize")).toEqual({ id: first });
    expect(await runTransition(second, "finalize")).toEqual({ id: second });
    const readNumber = async (invoiceId: SafeId<"invoice">) =>
      (
        await testDb.query.invoices.findFirst({
          where: { id: { eq: invoiceId } },
          columns: { invoiceNumber: true },
        })
      )?.invoiceNumber;
    expect(await readNumber(first)).toBe("AUTO-2026-001");
    expect(await readNumber(second)).toBe("AUTO-2026-002");
    expect(await runTransition(first, "revert_to_draft")).toEqual({
      id: first,
    });
    expect(await readNumber(first)).toBe("AUTO-2026-001");
    await assertAssignedNumber(first, "AUTO-2026-001");
    expect(await runTransition(first, "finalize")).toEqual({ id: first });
    expect(await readNumber(first)).toBe("AUTO-2026-001");
    const third = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: null,
    });
    expect(await runTransition(third, "finalize")).toEqual({ id: third });
    expect(await readNumber(third)).toBe("AUTO-2026-003");
    await testDb.delete(numberSeries).where(eq(numberSeries.id, seriesId));
  });

  test("preserves a manual number through edits after reverting to draft", async () => {
    const invoiceId = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: "REVERTED-001",
    });
    expect(await runTransition(invoiceId, "finalize")).toEqual({
      id: invoiceId,
    });
    expect(await runTransition(invoiceId, "revert_to_draft")).toEqual({
      id: invoiceId,
    });
    await assertAssignedNumber(invoiceId, "REVERTED-001");
    expect(await runTransition(invoiceId, "finalize")).toEqual({
      id: invoiceId,
    });
    const invoice = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
    });
    expect(invoice?.invoiceNumber).toBe("REVERTED-001");
  });

  test("a draft that was never finalized can still change, clear and lose its number", async () => {
    const invoiceId = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: "DRAFT-001",
    });
    const context = createContext({
      invoiceId,
      action: "finalize",
      auditEvents: [],
    });
    for (const invoiceNumber of ["DRAFT-002", null, "DRAFT-003"]) {
      expect(
        await updateInvoice.handler({ ...context, body: { invoiceNumber } }),
      ).toEqual({ id: invoiceId });
      const row = await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { invoiceNumber: true },
      });
      expect(row?.invoiceNumber).toBe(invoiceNumber);
    }
    expect(
      await deleteInvoice.handler(
        asTestRaw<Parameters<typeof deleteInvoice.handler>[0]>(context),
      ),
    ).toEqual({ deleted: true });
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
      }),
    ).toBeUndefined();
  });

  test("requires a default series for an unnumbered invoice but preserves a manual number", async () => {
    const unnumbered = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: null,
    });
    expect(await runTransition(unnumbered, "finalize")).toMatchObject({
      code: 409,
      response: { hint: expect.any(String) },
    });
    expect(await readInvoiceStatus(unnumbered)).toBe(INVOICE_STATUS.DRAFT);
    const manual = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: "MANUAL-001",
    });
    expect(await runTransition(manual, "finalize")).toEqual({ id: manual });
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: manual } },
        columns: { invoiceNumber: true },
      }),
    ).toEqual({ invoiceNumber: "MANUAL-001" });
  });

  test("marking an invoice paid records the time and voiding clears it", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    expect(await runTransition(invoiceId, "mark_paid")).toEqual({
      id: invoiceId,
    });
    const paid = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
      columns: { paidAt: true },
    });
    expect(paid?.paidAt).toBeInstanceOf(Date);
    expect(await runTransition(invoiceId, "void")).toEqual({ id: invoiceId });
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { paidAt: true },
      }),
    ).toEqual({ paidAt: null });
  });

  test("voiding a paid invoice detaches billed entries and expenses", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.PAID });
    const timeEntryId = createSafeId<"timeEntry">();
    const expenseId = createSafeId<"expense">();
    seededTimeEntryIds.push(timeEntryId);
    seededExpenseIds.push(expenseId);

    await testDb.insert(timeEntries).values({
      id: timeEntryId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      workItemId: ids.entityA1,
      dateWorked: "2026-06-23",
      timezoneId: "UTC",
      durationMinutes: 30,
      billedMinutes: 30,
      rateAtEntry: cents(200),
      currency: "USD",
      narrative: "Transition integration time entry",
      status: BILLING_STATUS.BILLED,
      invoiceId,
    });
    await testDb.insert(expenses).values({
      id: expenseId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      matterId: ids.entityA1,
      dateIncurred: "2026-06-23",
      amount: cents(100),
      currency: "USD",
      category: "filing_fee",
      description: "Transition integration expense",
      status: BILLING_STATUS.BILLED,
      invoiceId,
    });

    const auditEvents: AuditEvent[] = [];
    const result = await runTransition(invoiceId, "void", auditEvents);

    expect(result).toEqual({ id: invoiceId });
    expect(await readInvoiceStatus(invoiceId)).toBe(INVOICE_STATUS.VOID);
    expect(
      await testDb.query.timeEntries.findFirst({
        where: { id: { eq: timeEntryId } },
        columns: { invoiceId: true, status: true },
      }),
    ).toEqual({ invoiceId: null, status: BILLING_STATUS.APPROVED });
    expect(
      await testDb.query.expenses.findFirst({
        where: { id: { eq: expenseId } },
        columns: { invoiceId: true, status: true },
      }),
    ).toEqual({ invoiceId: null, status: BILLING_STATUS.APPROVED });
    expect(auditEvents.map((event) => event.resourceId)).toEqual([
      invoiceId,
      timeEntryId,
      expenseId,
    ]);
  });
});

const seedInvoice = async ({
  status,
  invoiceNumber,
}: {
  status: (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];
  invoiceNumber?: string | null;
}) => {
  const invoiceId = createSafeId<"invoice">();
  seededInvoiceIds.push(invoiceId);
  await testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber:
      invoiceNumber === undefined ? `INV-TEST-${invoiceId}` : invoiceNumber,
    invoiceDate: "2026-06-23",
    currency: "USD",
    status,
  });
  return invoiceId;
};

const runTransition = async (
  invoiceId: SafeId<"invoice">,
  action: TransitionCtx["body"]["action"],
  auditEvents: AuditEvent[] = [],
) =>
  await transitionInvoice.handler(
    createContext({
      action,
      auditEvents,
      invoiceId,
    }),
  );

const createContext = ({
  action,
  auditEvents,
  invoiceId,
}: {
  action: TransitionCtx["body"]["action"];
  auditEvents: AuditEvent[];
  invoiceId: SafeId<"invoice">;
}): TransitionCtx => {
  const scopedDb = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const recordAuditEvent: TransitionCtx["recordAuditEvent"] = async (
    _tx,
    events,
  ) => {
    if (Array.isArray(events)) {
      auditEvents.push(...events);
      return;
    }
    auditEvents.push(events);
  };

  return asTestRaw<TransitionCtx>({
    getActiveWorkspaceIds: async () => [ids.wsA1],
    getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
    getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
    body: { action },
    createAuditRecorder: () => recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
    params: { workspaceId: ids.wsA1, invoiceId },
    promptCachingEnabled: false,
    recordAuditEvent,
    request: new Request(`https://example.test/workspaces/${ids.wsA1}`),
    route: "/test/invoices/transition",
    safeDb,
    scopedDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  });
};

const readInvoiceStatus = async (invoiceId: SafeId<"invoice">) => {
  const row = await testDb.query.invoices.findFirst({
    where: { id: { eq: invoiceId } },
    columns: { status: true },
  });
  return row?.status ?? null;
};

const assertAssignedNumber = async (
  invoiceId: SafeId<"invoice">,
  assignedNumber: string,
) => {
  const context = createContext({
    invoiceId,
    action: "finalize",
    auditEvents: [],
  });
  for (const invoiceNumber of [null, `${assignedNumber}-CHANGED`]) {
    const result = await updateInvoice.handler({
      ...context,
      body: { invoiceNumber },
    });
    expect(result).toMatchObject({ code: 409 });
    const invoice = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
    });
    expect(invoice?.invoiceNumber).toBe(assignedNumber);
  }
  expect(
    await updateInvoice.handler({
      ...context,
      body: { invoiceNumber: assignedNumber },
    }),
  ).toEqual({ id: invoiceId });
  expect(
    await updateInvoice.handler({
      ...context,
      body: { notes: "Updated notes" },
    }),
  ).toEqual({ id: invoiceId });
};
