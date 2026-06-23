import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import transitionInvoice from "./transition";

setDefaultTimeout(120_000);

type TransitionCtx = Parameters<typeof transitionInvoice.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

const seededInvoiceIds: SafeId<"invoice">[] = [];
const seededTimeEntryIds: SafeId<"timeEntry">[] = [];
const seededExpenseIds: SafeId<"expense">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
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
      matterId: ids.entityA1,
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
}: {
  status: (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];
}) => {
  const invoiceId = createSafeId<"invoice">();
  seededInvoiceIds.push(invoiceId);
  await testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber: `INV-TEST-${invoiceId}`,
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
    activeWorkspaceIds: [ids.wsA1],
    accessibleWorkspaces: [{ id: ids.wsA1, status: "active" }],
    body: { action },
    createAuditRecorder: () => async () => undefined,
    memberRole: { role: "owner" },
    orgAIConfig: null,
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
