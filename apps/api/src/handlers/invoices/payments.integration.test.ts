import { panic } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { invoices, invoiceLines, INVOICE_STATUS } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
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

import getInvoice from "./get";
import listInvoices from "./list";
import transitionInvoice from "./transition";

setDefaultTimeout(120_000);
let db: TestDatabase;
let ids: TestIds;
const invoiceIds: SafeId<"invoice">[] = [];
beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
});
afterAll(async () => {
  if (invoiceIds.length) {
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
  }
  await releaseRlsFixture();
});

const context = <TContext>(
  _handler: (context: TContext) => unknown,
  options: {
    invoiceId?: SafeId<"invoice">;
    body?: unknown;
    role?: "owner" | "admin" | "member";
    events?: AuditEvent[];
  },
): TContext => {
  const recordAuditEvent = async (
    _tx: unknown,
    events: AuditEvent | AuditEvent[],
  ) => {
    options.events?.push(...(Array.isArray(events) ? events : [events]));
  };
  return asTestRaw<TContext>({
    body: options.body ?? {},
    query: { limit: 100 },
    params: { workspaceId: ids.wsA1, invoiceId: options.invoiceId },
    workspaceId: ids.wsA1,
    user: { id: ids.userA1 },
    session: { activeOrganizationId: ids.orgA },
    memberRole: { role: options.role ?? "owner" },
    safeDb: createSafeDb(db, [ids.wsA1], ids.orgA, ids.userA1),
    scopedDb: createScopedDb(db, [ids.wsA1], ids.orgA, ids.userA1),
    request: new Request("https://example.test/invoices/payment", {
      method: "POST",
    }),
    route: "/test/invoice-payment",
    recordAuditEvent,
    createAuditRecorder: () => recordAuditEvent,
    getActiveWorkspaceIds: async () => [ids.wsA1],
    getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
    getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
  });
};
const seedInvoice = async (
  options: {
    documentType?: "invoice" | "advance" | "credit_note";
    originalInvoiceId?: SafeId<"invoice">;
    amount?: number;
  } = {},
) => {
  const id = createSafeId<"invoice">();
  invoiceIds.push(id);
  const amount = options.amount ?? 1000;
  await db.insert(invoices).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber: `PAY-${id}`,
    invoiceDate: "2026-09-29",
    currency: "USD",
    status: INVOICE_STATUS.SENT,
    documentType: options.documentType ?? "invoice",
    originalInvoiceId: options.originalInvoiceId ?? null,
    netAmount: cents(amount),
    vatAmount: cents(0),
    totalAmount: cents(amount),
  });
  await db.insert(invoiceLines).values({
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceId: id,
    position: 0,
    description: "Agreed services",
    quantity: "1",
    unitPrice: cents(Math.abs(amount)),
    netAmount: cents(amount),
    vatAmount: cents(0),
    grossAmount: cents(amount),
    source: "manual",
    vatRateBps: 0,
    vatTreatment: "domestic_vat",
  });
  return id;
};
const read = async (id: SafeId<"invoice">) =>
  await db.query.invoices.findFirst({ where: { id: { eq: id } } });
const run = async (
  invoiceId: SafeId<"invoice">,
  body: unknown,
  events: AuditEvent[] = [],
  role: "owner" | "admin" | "member" = "owner",
) =>
  await transitionInvoice.handler(
    context(transitionInvoice.handler, { invoiceId, body, events, role }),
  );

test.each(["invoice", "advance"] as const)(
  "full %s payment stores exact date/amount and is exposed through detail and list",
  async (documentType) => {
    const amount = 5_000_000_001;
    const invoiceId = await seedInvoice({ documentType, amount });
    const events: AuditEvent[] = [];
    expect(
      await run(
        invoiceId,
        {
          action: "mark_paid",
          paidDate: "2026-09-29",
          paidAmountMinor: amount,
          note: "Bank transfer",
          reference: "BANK-42",
        },
        events,
      ),
    ).toEqual({ id: invoiceId });
    const paid = await read(invoiceId);
    expect(paid).toMatchObject({
      status: "paid",
      paidDate: "2026-09-29",
      paidAmount: amount,
      paymentNote: "Bank transfer",
      paymentReference: "BANK-42",
    });
    expect(paid?.paidAt).toBeInstanceOf(Date);
    expect(events).toHaveLength(1);
    expect(events.at(0)).toMatchObject({
      changes: {
        paidAmount: { old: null, new: amount },
        paymentReference: { old: null, new: "BANK-42" },
      },
    });
    expect(
      await getInvoice.handler(context(getInvoice.handler, { invoiceId })),
    ).toMatchObject({
      paidDate: "2026-09-29",
      paidAmount: amount,
      paymentNote: "Bank transfer",
    });
    expect(
      await listInvoices.handler(context(listInvoices.handler, {})),
    ).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: invoiceId,
          paidDate: "2026-09-29",
          paidAmount: amount,
          paymentReference: "BANK-42",
        }),
      ]),
    });
  },
);

test("payment defaults use UTC today/full amount and identical replay has no duplicate effects", async () => {
  const invoiceId = await seedInvoice();
  const events: AuditEvent[] = [];
  const before = new Date().toISOString().slice(0, 10);
  expect(await run(invoiceId, { action: "mark_paid" }, events)).toEqual({
    id: invoiceId,
  });
  const paid = await read(invoiceId);
  const after = new Date().toISOString().slice(0, 10);
  expect([before, after]).toContain(paid?.paidDate);
  expect(paid?.paidAmount).toBe(1000);
  const paidAt = paid?.paidAt?.toISOString();
  expect(await run(invoiceId, { action: "mark_paid" }, events)).toEqual({
    id: invoiceId,
  });
  expect((await read(invoiceId))?.paidAt?.toISOString()).toBe(paidAt);
  expect(events).toHaveLength(1);
  expect(
    await run(
      invoiceId,
      { action: "mark_paid", note: "Changed metadata" },
      events,
    ),
  ).toMatchObject({
    code: 409,
    response: { code: "payment_details_conflict" },
  });
  expect(events).toHaveLength(1);
});

test.each([0, 999, 1001])(
  "non-full payment %p is refused atomically",
  async (paidAmountMinor) => {
    const invoiceId = await seedInvoice();
    const events: AuditEvent[] = [];
    expect(
      await run(invoiceId, { action: "mark_paid", paidAmountMinor }, events),
    ).toMatchObject({
      code: 409,
      response: {
        code: "partial_payment_not_supported",
        hint: expect.any(String),
      },
    });
    expect(await read(invoiceId)).toMatchObject({
      status: "sent",
      paidAt: null,
      paidDate: null,
      paidAmount: null,
    });
    expect(events).toHaveLength(0);
  },
);

test("credit notes refuse client payment without inventing a refund state", async () => {
  const originalInvoiceId = await seedInvoice();
  const invoiceId = await seedInvoice({
    documentType: "credit_note",
    originalInvoiceId,
    amount: -1000,
  });
  expect(await run(invoiceId, { action: "mark_paid" })).toMatchObject({
    code: 409,
    response: { code: "credit_note_payment_unsupported" },
  });
  expect(await read(invoiceId)).toMatchObject({
    status: "sent",
    paidAt: null,
    paidAmount: null,
  });
});

test("only an organization owner/admin can undo, and undo replay creates no duplicate audit", async () => {
  const invoiceId = await seedInvoice();
  const events: AuditEvent[] = [];
  await run(
    invoiceId,
    {
      action: "mark_paid",
      paidDate: "2026-09-29",
      note: "Receipt",
      reference: "REF-1",
    },
    events,
  );
  expect(
    await run(invoiceId, { action: "undo_paid" }, events, "member"),
  ).toMatchObject({ code: 403 });
  expect((await read(invoiceId))?.status).toBe("paid");
  expect(
    await run(invoiceId, { action: "undo_paid" }, events, "admin"),
  ).toEqual({ id: invoiceId });
  expect(await read(invoiceId)).toMatchObject({
    status: "sent",
    paidAt: null,
    paidDate: null,
    paidAmount: null,
    paymentNote: null,
    paymentReference: null,
  });
  expect(events.at(-1)).toMatchObject({
    changes: {
      paidDate: { old: "2026-09-29", new: null },
      paymentReference: { old: "REF-1", new: null },
    },
  });
  const auditCount = events.length;
  expect(await run(invoiceId, { action: "undo_paid" }, events)).toEqual({
    id: invoiceId,
  });
  expect(events).toHaveLength(auditCount);
});

test("void clears payment details together and keeps the removed metadata in audit", async () => {
  const invoiceId = await seedInvoice();
  const events: AuditEvent[] = [];
  await run(
    invoiceId,
    {
      action: "mark_paid",
      paidDate: "2026-09-29",
      note: "Paid note",
      reference: "R-2",
    },
    events,
  );
  expect(await run(invoiceId, { action: "void" }, events)).toEqual({
    id: invoiceId,
  });
  expect(await read(invoiceId)).toMatchObject({
    status: "void",
    paidAt: null,
    paidDate: null,
    paidAmount: null,
    paymentNote: null,
    paymentReference: null,
  });
  expect(events.at(-1)).toMatchObject({
    changes: {
      status: { old: "paid", new: "void" },
      paymentNote: { old: "Paid note", new: null },
      paidAmount: { old: 1000, new: null },
    },
  });
});

test("rolling API tasks can still write paidAt-only payments and void new metadata", async () => {
  const legacyId = await seedInvoice();
  await db
    .update(invoices)
    .set({
      status: INVOICE_STATUS.PAID,
      paidAt: new Date("2026-09-28T23:00:00Z"),
    })
    .where(inArray(invoices.id, [legacyId]));
  const events: AuditEvent[] = [];
  expect(await run(legacyId, { action: "mark_paid" }, events)).toEqual({
    id: legacyId,
  });
  expect(await read(legacyId)).toMatchObject({
    paidDate: null,
    paidAmount: null,
  });
  expect(events).toHaveLength(0);
  const newId = await seedInvoice();
  await run(newId, { action: "mark_paid", note: "Historical receipt" });
  await db
    .update(invoices)
    .set({ status: INVOICE_STATUS.VOID, paidAt: null })
    .where(inArray(invoices.id, [newId]));
  expect(await read(newId)).toMatchObject({
    status: "void",
    paidAt: null,
    paidAmount: 1000,
    paymentNote: "Historical receipt",
  });
});

test("cross-tenant payment transition never changes the inaccessible invoice", async () => {
  const before = await read(ids.invoiceB1);
  if (!before) {
    panic("Foreign invoice fixture is missing");
  }
  expect(await run(ids.invoiceB1, { action: "mark_paid" })).toMatchObject({
    code: 409,
  });
  expect(await read(ids.invoiceB1)).toEqual(before);
});
