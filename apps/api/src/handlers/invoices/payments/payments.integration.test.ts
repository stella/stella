import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { user as authUser } from "@/api/db/auth-schema";
import type { OnlineMigrationConnection } from "@/api/db/online-migration-connection";
import {
  featureEnrolments,
  INVOICE_STATUS,
  invoicePayments,
  invoices,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import {
  INVOICE_LEGACY_PAYMENT_BACKFILL,
  INVOICE_SENT_AT_BACKFILL,
  LEGACY_PAYMENT_NOTE,
} from "@/api/lib/billing/invoice-payment-backfill";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import readInvoiceById from "../get";
import readInvoices from "../list";
import transitionInvoice from "../transition";
import recordInvoicePayment from "./create";
import listInvoicePayments from "./list";
import voidInvoicePayment from "./void";

setDefaultTimeout(120_000); // timeout: the shared PGlite RLS fixture builds its schema once for the file

let testDb: TestDatabase;
let ids: TestIds;
const seededInvoiceIds: SafeId<"invoice">[] = [];

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
    if (seededInvoiceIds.length > 0) {
      // The owner connection removes what the request role may only void.
      await testDb
        .delete(invoicePayments)
        .where(inArray(invoicePayments.invoiceId, seededInvoiceIds));
      await testDb
        .delete(invoices)
        .where(inArray(invoices.id, seededInvoiceIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const PAID_ON = Temporal.Now.plainDateISO("UTC")
  .subtract({ days: 1 })
  .toString();

// A seeded sent (or paid) invoice was marked sent, as the send transition does.
const sentAtFor = (status: InvoiceStatus) =>
  status === INVOICE_STATUS.SENT || status === INVOICE_STATUS.PAID
    ? new Date("2026-06-24T09:00:00Z")
    : null;

/**
 * A seeded invoice. `legacy` seeds one as stored before payment records and
 * sent markers existed: no sent marker, and a paid one carries only paidAt.
 */
const seedInvoice = async ({
  status,
  totalAmount = 10_000,
  documentType = "invoice",
  legacy,
}: {
  status: InvoiceStatus;
  totalAmount?: number;
  documentType?: "invoice" | "credit_note";
  legacy?: { paidAt: Date | null };
}) => {
  const stored =
    legacy === undefined
      ? { sentAt: sentAtFor(status) }
      : { sentAt: null, paidAt: legacy.paidAt };
  const invoiceId = createSafeId<"invoice">();
  seededInvoiceIds.push(invoiceId);
  if (documentType === "credit_note") {
    const original = await seedInvoice({
      status: INVOICE_STATUS.SENT,
      totalAmount: Math.abs(totalAmount),
    });
    await testDb.insert(invoices).values({
      id: invoiceId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceNumber: `CN-PAY-${invoiceId}`,
      documentType,
      originalInvoiceId: original,
      invoiceDate: "2026-06-23",
      currency: "USD",
      status,
      ...stored,
      totalAmount: cents(totalAmount),
    });
    return invoiceId;
  }
  await testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber: `INV-PAY-${invoiceId}`,
    invoiceDate: "2026-06-23",
    currency: "USD",
    status,
    ...stored,
    totalAmount: cents(totalAmount),
  });
  return invoiceId;
};

type AnyHandler = { handler: (ctx: never) => Promise<unknown> };

const run = async (
  handler: AnyHandler,
  {
    params,
    body = {},
    route,
    auditEvents = [],
    workspaceId = ids.wsA1,
    userId = ids.userA1,
  }: {
    params: Record<string, string>;
    body?: unknown;
    route: ApiRoutePath;
    auditEvents?: AuditEvent[];
    workspaceId?: SafeId<"workspace">;
    userId?: SafeId<"user">;
  },
) => {
  const recordAuditEvent = async (
    _tx: unknown,
    events: AuditEvent | AuditEvent[],
  ) => {
    auditEvents.push(...(Array.isArray(events) ? events : [events]));
  };
  return await handler.handler(
    asTestRaw<never>({
      getActiveWorkspaceIds: async () => [workspaceId],
      getAccessibleWorkspaces: async () => [
        { id: workspaceId, status: "active" },
      ],
      getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
      body,
      query: {},
      createAuditRecorder: () => recordAuditEvent,
      memberRole: sessionMemberRole("owner"),
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu" as const,
      params: { workspaceId, ...params },
      promptCachingEnabled: false,
      recordAuditEvent,
      request: new Request(`https://example.test/workspaces/${workspaceId}`),
      route,
      safeDb: createSafeDb(testDb, [workspaceId], ids.orgA, userId),
      scopedDb: createScopedDb(testDb, [workspaceId], ids.orgA, userId),
      session: { activeOrganizationId: ids.orgA },
      user: { id: userId },
      workspaceId,
    }),
  );
};

const record = async (
  invoiceId: SafeId<"invoice">,
  body: Record<string, unknown>,
  auditEvents: AuditEvent[] = [],
) =>
  await run(recordInvoicePayment, {
    params: { invoiceId },
    // As the route parses it: text trimmed, blank text stored as none.
    body: v.parse(recordInvoicePayment.config.body, {
      paidOn: PAID_ON,
      method: "bank_transfer",
      ...body,
    }),
    route: "/v1/invoices/:workspaceId/:invoiceId/payments",
    auditEvents,
  });

const voidPayment = async (invoiceId: SafeId<"invoice">, paymentId: string) =>
  await run(voidInvoicePayment, {
    params: { invoiceId, paymentId },
    route: "/v1/invoices/:workspaceId/:invoiceId/payments/:paymentId/void",
  });

const readDetail = async (invoiceId: SafeId<"invoice">) =>
  await run(readInvoiceById, {
    params: { invoiceId },
    route: "/v1/invoices/:workspaceId/:invoiceId",
  });

const readStored = async (invoiceId: SafeId<"invoice">) =>
  await testDb.query.invoices.findFirst({
    where: { id: { eq: invoiceId } },
    columns: { status: true, paidAt: true, totalAmount: true },
  });

const storedPayments = async (invoiceId: SafeId<"invoice">) =>
  await testDb
    .select({
      amount: invoicePayments.amount,
      voided: invoicePayments.voidedAt,
    })
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId));

const storedPaymentIds = async (invoiceId: SafeId<"invoice">) =>
  (
    await testDb
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invoiceId))
  ).map(({ id }) => id);

// The online phase's connection, over the fixture's database owner.
const onlineConnection = (): OnlineMigrationConnection => ({
  execute: async (query, params = []) => {
    await testDb.$client.query(query, [...params]);
  },
  query: async (query, params = []) =>
    (await testDb.$client.query(query, [...params])).rows,
  release: () => {},
});

const runInvoiceBackfills = async () => {
  const connection = onlineConnection();
  await INVOICE_SENT_AT_BACKFILL.repair(connection);
  await INVOICE_LEGACY_PAYMENT_BACKFILL.repair(connection);
};

const paymentIdOf = (result: unknown): string =>
  isRecord(result) && typeof result["id"] === "string"
    ? result["id"]
    : panic("Expected a recorded payment", { result });

const listedItems = (result: unknown): unknown[] =>
  isRecord(result) && Array.isArray(result["items"])
    ? result["items"]
    : panic("Expected an invoice page", { result });

describe("invoice payments", () => {
  test("a partial payment keeps the invoice sent; the remainder marks it paid", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const auditEvents: AuditEvent[] = [];

    const first = await record(
      invoiceId,
      { amount: 4000, reference: "  VS 2026001 ", note: "" },
      auditEvents,
    );
    expect(first).toMatchObject({
      invoiceId,
      amount: 4000,
      paidOn: PAID_ON,
      method: "bank_transfer",
      reference: "VS 2026001",
      note: null,
      recordedBy: ids.userA1,
      voidedAt: null,
    });
    expect(await readStored(invoiceId)).toMatchObject({
      status: INVOICE_STATUS.SENT,
      paidAt: null,
    });
    expect(await readDetail(invoiceId)).toMatchObject({
      status: INVOICE_STATUS.SENT,
      paidAmount: 4000,
      outstandingAmount: 6000,
      payments: [{ id: paymentIdOf(first), amount: 4000 }],
    });

    expect(
      await record(invoiceId, { amount: 6000, method: "card" }),
    ).toMatchObject({ amount: 6000, method: "card" });
    const stored = await readStored(invoiceId);
    expect(stored?.status).toBe(INVOICE_STATUS.PAID);
    expect(stored?.paidAt).toBeInstanceOf(Date);
    expect(await readDetail(invoiceId)).toMatchObject({
      paidAmount: 10_000,
      outstandingAmount: 0,
    });
    expect(auditEvents).toEqual([
      expect.objectContaining({
        resourceId: invoiceId,
        changes: expect.objectContaining({
          paidAmount: { old: 0, new: 4000 },
        }),
      }),
    ]);
  });

  test("a payment above the outstanding amount is refused and writes nothing", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    await record(invoiceId, { amount: 7000 });

    expect(await record(invoiceId, { amount: 3001 })).toMatchObject({
      code: 409,
      response: {
        message: "The payment is more than the invoice's outstanding amount",
        hint: "30.00 USD is outstanding; record that amount or less.",
      },
    });
    expect(await storedPayments(invoiceId)).toEqual([
      { amount: 7000, voided: null },
    ]);
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.SENT);
  });

  test.each([
    [INVOICE_STATUS.DRAFT, "A draft invoice cannot take payments"],
    [INVOICE_STATUS.VOID, "A void invoice cannot take payments"],
  ])("a %s invoice takes no payment", async (status, message) => {
    const invoiceId = await seedInvoice({ status });
    expect(await record(invoiceId, { amount: 100 })).toMatchObject({
      code: 409,
      response: { message },
    });
    expect(await storedPayments(invoiceId)).toEqual([]);
    expect((await readStored(invoiceId))?.status).toBe(status);
  });

  test("a payment dated after today is refused", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const tomorrow = Temporal.Now.plainDateISO("Pacific/Kiritimati")
      .add({ days: 1 })
      .toString();
    expect(
      await record(invoiceId, { amount: 100, paidOn: tomorrow }),
    ).toMatchObject({ code: 422 });
    expect(await storedPayments(invoiceId)).toEqual([]);
  });

  test("voiding a payment keeps its record and returns a paid invoice to sent", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const paymentId = paymentIdOf(await record(invoiceId, { amount: 10_000 }));
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.PAID);

    expect(await voidPayment(invoiceId, paymentId)).toMatchObject({
      id: paymentId,
      voidedAt: expect.any(String),
    });
    expect(await readStored(invoiceId)).toMatchObject({
      status: INVOICE_STATUS.SENT,
      paidAt: null,
    });
    const [kept] = await storedPayments(invoiceId);
    expect(kept?.amount).toBe(10_000);
    expect(kept?.voided).toBeInstanceOf(Date);
    expect(await voidPayment(invoiceId, paymentId)).toMatchObject({
      code: 404,
    });
    expect(
      await run(listInvoicePayments, {
        params: { invoiceId },
        route: "/v1/invoices/:workspaceId/:invoiceId/payments",
      }),
    ).toMatchObject({
      currency: "USD",
      paidAmount: 0,
      outstandingAmount: 10_000,
      items: [{ id: paymentId, voidedAt: expect.any(String) }],
    });
    // The voided payment no longer counts: the full amount can be paid again.
    await record(invoiceId, { amount: 10_000 });
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.PAID);
  });

  test("a finalized invoice takes payments, is paid when settled and returns to finalized", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    await record(invoiceId, { amount: 4000 });
    expect(await readDetail(invoiceId)).toMatchObject({
      status: INVOICE_STATUS.FINALIZED,
      sentAt: null,
      paidAmount: 4000,
      outstandingAmount: 6000,
    });
    const paymentId = paymentIdOf(await record(invoiceId, { amount: 6000 }));
    const paid = await readStored(invoiceId);
    expect(paid?.status).toBe(INVOICE_STATUS.PAID);
    expect(paid?.paidAt).toBeInstanceOf(Date);

    await voidPayment(invoiceId, paymentId);
    // Never marked sent, so it goes back to finalized, not sent.
    expect(await readStored(invoiceId)).toMatchObject({
      status: INVOICE_STATUS.FINALIZED,
      paidAt: null,
    });
  });

  test("an invoice sent by the transition returns to sent when its payment is voided", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    expect(
      await run(transitionInvoice, {
        params: { invoiceId },
        body: { action: "send" },
        route: "/v1/invoices/:workspaceId/:invoiceId/transition",
      }),
    ).toEqual({ id: invoiceId });
    const sent = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
      columns: { sentAt: true },
    });
    expect(sent?.sentAt).toBeInstanceOf(Date);
    const paymentId = paymentIdOf(await record(invoiceId, { amount: 10_000 }));
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.PAID);
    await voidPayment(invoiceId, paymentId);
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.SENT);
  });

  test("a finalized invoice with unvoided payments cannot be reverted to draft", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.FINALIZED });
    const paymentId = paymentIdOf(await record(invoiceId, { amount: 2500 }));
    const revert = async () =>
      await run(transitionInvoice, {
        params: { invoiceId },
        body: { action: "revert_to_draft" },
        route: "/v1/invoices/:workspaceId/:invoiceId/transition",
      });
    expect(await revert()).toMatchObject({
      code: 409,
      response: {
        message: "Void the invoice's payments before reverting it to draft",
      },
    });
    expect((await readStored(invoiceId))?.status).toBe(
      INVOICE_STATUS.FINALIZED,
    );
    await voidPayment(invoiceId, paymentId);
    expect(await revert()).toEqual({ id: invoiceId });
  });

  test("a paid invoice takes no further payment until one is voided", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const paymentId = paymentIdOf(await record(invoiceId, { amount: 10_000 }));
    expect(await record(invoiceId, { amount: 1 })).toMatchObject({
      code: 409,
      response: {
        message: "This invoice is already paid; nothing is outstanding",
      },
    });
    await voidPayment(invoiceId, paymentId);
    expect(await record(invoiceId, { amount: 1 })).toMatchObject({
      amount: 1,
    });
  });

  test("an invoice sent before sent markers existed is backfilled and returns to sent", async () => {
    const invoiceId = await seedInvoice({
      status: INVOICE_STATUS.SENT,
      legacy: { paidAt: null },
    });
    await INVOICE_SENT_AT_BACKFILL.repair(onlineConnection());
    expect(await readDetail(invoiceId)).toMatchObject({
      sentAt: expect.any(String),
    });

    const paymentId = paymentIdOf(await record(invoiceId, { amount: 10_000 }));
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.PAID);
    await voidPayment(invoiceId, paymentId);
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.SENT);
  });

  test("an invoice marked paid before payment records existed gets its settling payment", async () => {
    const paidAt = new Date("2026-07-01T10:00:00Z");
    const invoiceId = await seedInvoice({
      status: INVOICE_STATUS.PAID,
      legacy: { paidAt },
    });
    const creditNoteId = await seedInvoice({
      status: INVOICE_STATUS.PAID,
      documentType: "credit_note",
      totalAmount: -2500,
      legacy: { paidAt },
    });
    await runInvoiceBackfills();

    expect(await readDetail(invoiceId)).toMatchObject({
      status: INVOICE_STATUS.PAID,
      sentAt: paidAt.toISOString(),
      paidAmount: 10_000,
      outstandingAmount: 0,
      payments: [
        {
          amount: 10_000,
          paidOn: "2026-07-01",
          method: "other",
          note: LEGACY_PAYMENT_NOTE,
          recordedBy: null,
          voidedAt: null,
        },
      ],
    });
    expect(await readDetail(creditNoteId)).toMatchObject({
      paidAmount: 2500,
      outstandingAmount: 0,
    });
    expect(await record(invoiceId, { amount: 4000 })).toMatchObject({
      code: 409,
    });
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.PAID);

    // Voiding the recorded settlement reopens it as the sent invoice it was.
    const [settlement] = await storedPaymentIds(invoiceId);
    await voidPayment(invoiceId, settlement ?? "");
    expect(await readDetail(invoiceId)).toMatchObject({
      status: INVOICE_STATUS.SENT,
      outstandingAmount: 10_000,
    });
  });

  test("the invoice backfills reach a fixed point: a second run changes nothing", async () => {
    const paidId = await seedInvoice({
      status: INVOICE_STATUS.PAID,
      legacy: { paidAt: new Date("2026-07-02T08:00:00Z") },
    });
    const sentId = await seedInvoice({
      status: INVOICE_STATUS.SENT,
      legacy: { paidAt: null },
    });
    const connection = onlineConnection();
    expect(
      (await INVOICE_LEGACY_PAYMENT_BACKFILL.readCompletion(connection)).type,
    ).toBe("incomplete");
    expect(
      (await INVOICE_SENT_AT_BACKFILL.readCompletion(connection)).type,
    ).toBe("incomplete");
    await runInvoiceBackfills();
    const snapshot = async () => ({
      invoices: await testDb
        .select()
        .from(invoices)
        .where(inArray(invoices.id, [paidId, sentId])),
      payments: await testDb
        .select()
        .from(invoicePayments)
        .where(inArray(invoicePayments.invoiceId, [paidId, sentId])),
    });
    const first = await snapshot();
    expect(first.payments).toHaveLength(1);
    await runInvoiceBackfills();
    expect(await snapshot()).toEqual(first);
    expect(
      (await INVOICE_LEGACY_PAYMENT_BACKFILL.readCompletion(connection)).type,
    ).toBe("complete");
    expect(
      (await INVOICE_SENT_AT_BACKFILL.readCompletion(connection)).type,
    ).toBe("complete");
  });

  test("an invoice with unvoided payments cannot be voided", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const paymentId = paymentIdOf(await record(invoiceId, { amount: 2500 }));
    const transition = async () =>
      await run(transitionInvoice, {
        params: { invoiceId },
        body: { action: "void" },
        route: "/v1/invoices/:workspaceId/:invoiceId/transition",
      });

    expect(await transition()).toMatchObject({
      code: 409,
      response: {
        message: "Void the invoice's payments before voiding the invoice",
      },
    });
    expect((await readStored(invoiceId))?.status).toBe(INVOICE_STATUS.SENT);
    await voidPayment(invoiceId, paymentId);
    expect(await transition()).toEqual({ id: invoiceId });
  });

  test("a credit note settles when its refund reaches the credited amount", async () => {
    const creditNoteId = await seedInvoice({
      status: INVOICE_STATUS.SENT,
      documentType: "credit_note",
      totalAmount: -2500,
    });
    expect(await record(creditNoteId, { amount: 2501 })).toMatchObject({
      code: 409,
    });
    await record(creditNoteId, { amount: 2500 });
    expect((await readStored(creditNoteId))?.status).toBe(INVOICE_STATUS.PAID);
  });

  test("the invoice list shows each invoice's paid and outstanding amounts", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const paymentId = paymentIdOf(await record(invoiceId, { amount: 1500 }));
    await record(invoiceId, { amount: 500 });
    await voidPayment(invoiceId, paymentId);

    const listed = await run(readInvoices, {
      params: {},
      route: "/v1/invoices/:workspaceId",
    });
    expect(
      listedItems(listed).find(
        (item) => isRecord(item) && item["id"] === invoiceId,
      ),
    ).toMatchObject({
      status: INVOICE_STATUS.SENT,
      totalAmount: 10_000,
      paidAmount: 500,
      outstandingAmount: 9500,
    });
  });

  test("a member without the invoice's matter sees none of its payments", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    await record(invoiceId, { amount: 1000 });
    const outsider = createSafeDb(testDb, [ids.wsA2], ids.orgA, ids.userA2);
    const visible = await outsider(
      async (tx) =>
        await tx
          .select({ id: invoicePayments.id })
          .from(invoicePayments)
          .where(eq(invoicePayments.invoiceId, invoiceId)),
    );
    expect(visible.unwrap()).toEqual([]);
    const owner = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const own = await owner(
      async (tx) =>
        await tx
          .select({ id: invoicePayments.id })
          .from(invoicePayments)
          .where(eq(invoicePayments.invoiceId, invoiceId)),
    );
    expect(own.unwrap()).toHaveLength(1);
  });

  test("another organization cannot attach a payment to the invoice", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    const otherOrganization = createSafeDb(
      testDb,
      [ids.wsB1],
      ids.orgB,
      ids.userB1,
    );
    const insert = await otherOrganization(
      async (tx) =>
        await tx.insert(invoicePayments).values({
          organizationId: ids.orgB,
          invoiceId,
          amount: cents(100),
          paidOn: PAID_ON,
          method: "cash",
          recordedBy: ids.userB1,
        }),
    );
    expect(insert.isErr()).toBe(true);
    expect(await storedPayments(invoiceId)).toEqual([]);
  });

  test("the request role cannot delete a payment", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    await record(invoiceId, { amount: 1000 });
    const owner = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const removed = await owner(
      async (tx) =>
        await tx
          .delete(invoicePayments)
          .where(eq(invoicePayments.invoiceId, invoiceId))
          .returning({ id: invoicePayments.id }),
    );
    expect(removed.unwrap()).toEqual([]);
    expect(await storedPayments(invoiceId)).toHaveLength(1);
  });
});
