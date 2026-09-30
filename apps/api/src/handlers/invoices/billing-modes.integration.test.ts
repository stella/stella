import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  billingArrangements,
  INVOICE_ATTACHMENT,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createInvoice from "./create";
import deleteInvoice from "./delete";
import addEntries from "./entries/add";
import removeEntries from "./entries/remove";
import getInvoice from "./get";
import createLine from "./lines/create";
import deleteLine from "./lines/delete";
import updateLine from "./lines/update";
import transitionInvoice from "./transition";

setDefaultTimeout(120_000);
let db: TestDatabase;
let ids: TestIds;
const entryIds: SafeId<"timeEntry">[] = [];
const invoiceIds: SafeId<"invoice">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
});
afterEach(async () => {
  if (invoiceIds.length) {
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
  }
  if (entryIds.length) {
    await db.delete(timeEntries).where(inArray(timeEntries.id, entryIds));
  }
  await db
    .delete(billingArrangements)
    .where(eq(billingArrangements.workspaceId, ids.wsA2));
  entryIds.length = 0;
  invoiceIds.length = 0;
});
afterAll(releaseRlsFixture);

const context = <TContext>(
  _handler: (context: TContext) => unknown,
  body: unknown,
  params: Record<string, unknown> = {},
): TContext =>
  asTestRaw<TContext>({
    body,
    params: { workspaceId: ids.wsA2, ...params },
    query: {},
    workspaceId: ids.wsA2,
    safeDb: createSafeDb(db, [ids.wsA2], ids.orgA, ids.userA1),
    scopedDb: createScopedDb(db, [ids.wsA2], ids.orgA, ids.userA1),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    request: new Request("https://example.test/invoices", { method: "POST" }),
    route: "/test/billing-modes",
    memberRole: { role: "owner" },
    getWorkspaceAccess: async () => ({ id: ids.wsA2, status: "active" }),
    getActiveWorkspaceIds: async () => [ids.wsA2],
    getAccessibleWorkspaces: async () => [{ id: ids.wsA2, status: "active" }],
    recordAuditEvent: async () => {},
    createAuditRecorder: () => async () => {},
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
  });
const seedEntry = async (billable = true) => {
  const id = createSafeId<"timeEntry">();
  entryIds.push(id);
  await db.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
    dateWorked: "2026-09-30",
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: billable ? 60 : 0,
    rateAtEntry: cents(billable ? 600 : 0),
    currency: billable ? "USD" : UNPRICED_TIME_ENTRY_CURRENCY,
    billable,
    status: "approved",
    narrative: "Covered work retains its snapshot",
  });
  return id;
};
const setArrangement = async (mode: "hourly" | "flat_fee", amount: number) => {
  const row = {
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    mode,
    currency: "USD",
    flatFeeAmount: mode === "flat_fee" ? cents(amount) : null,
    capAmount: mode === "hourly" ? cents(amount) : null,
    alertThresholdBps: mode === "hourly" ? 8000 : null,
  };
  await db
    .insert(billingArrangements)
    .values(row)
    .onConflictDoUpdate({ target: billingArrangements.workspaceId, set: row });
};
const draft = async (timeEntryIds: SafeId<"timeEntry">[]) => {
  const result = await createInvoice.handler(
    context(createInvoice.handler, {
      invoiceNumber: `A10-${createSafeId<"invoice">()}`,
      invoiceDate: "2026-09-30",
      currency: "USD",
      timeEntryIds,
    }),
  );
  if ("id" in result) {
    invoiceIds.push(result.id);
  }
  return result;
};
const invoiceIdFrom = (result: Awaited<ReturnType<typeof draft>>) => {
  if (!("id" in result)) {
    return panic(`Invoice failed: ${JSON.stringify(result)}`);
  }
  return result.id;
};

test("flat fee snapshots one fee and covers both priced and unpriced client entries without double counting", async () => {
  await setArrangement("flat_fee", 1000);
  const priced = await seedEntry();
  const unpriced = await seedEntry(false);
  const invoiceId = invoiceIdFrom(await draft([priced, unpriced]));
  expect(
    await db.query.invoices.findFirst({ where: { id: { eq: invoiceId } } }),
  ).toMatchObject({
    billingMode: "flat_fee",
    flatFeeAmount: 1000,
    totalAmount: 1000,
  });
  const lines = await db.query.invoiceLines.findMany({
    where: { invoiceId: { eq: invoiceId } },
  });
  expect(lines).toHaveLength(1);
  expect(lines.at(0)).toMatchObject({
    source: "manual",
    billingPurpose: "flat_fee",
    netAmount: 1000,
  });
  for (const id of [priced, unpriced]) {
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: id } } }),
    ).toMatchObject({
      status: "billed",
      invoiceId,
      invoiceAttachment: INVOICE_ATTACHMENT.COVERED,
    });
  }
  const read = await getInvoice.handler(
    context(getInvoice.handler, {}, { invoiceId }),
  );
  expect(read).toMatchObject({
    netAmount: 1000,
    totals: { grossAmountMinor: 1000 },
  });
  // Editing the current arrangement must not reprice an already-created invoice.
  await setArrangement("flat_fee", 2000);
  expect(
    await updateLine.handler(
      context(
        updateLine.handler,
        { description: "Agreed fee" },
        { invoiceId, lineId: lines.at(0)?.id },
      ),
    ),
  ).toMatchObject({ totals: { grossAmountMinor: 1000 } });
  const detached = await removeEntries.handler(
    context(removeEntries.handler, { timeEntryIds: [priced] }, { invoiceId }),
  );
  expect(detached).toMatchObject({ success: true });
  expect(
    await db.query.timeEntries.findFirst({ where: { id: { eq: priced } } }),
  ).toMatchObject({
    status: "approved",
    invoiceId: null,
    invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
    rateAtEntry: 600,
    billedMinutes: 60,
  });
  expect(
    await db.query.invoices.findFirst({ where: { id: { eq: invoiceId } } }),
  ).toMatchObject({ totalAmount: 1000 });
});

test("covered time never prices an hourly charge even when that charge would overflow", async () => {
  await setArrangement("flat_fee", 1000);
  const entryId = await seedEntry();
  await db
    .update(timeEntries)
    .set({
      durationMinutes: 61,
      billedMinutes: 61,
      rateAtEntry: cents(Number.MAX_SAFE_INTEGER),
    })
    .where(eq(timeEntries.id, entryId));
  const invoiceId = invoiceIdFrom(await draft([entryId]));
  expect(
    await db.query.invoices.findFirst({ where: { id: { eq: invoiceId } } }),
  ).toMatchObject({ totalAmount: 1000, flatFeeAmount: 1000 });
  expect(
    await db.query.timeEntries.findFirst({ where: { id: { eq: entryId } } }),
  ).toMatchObject({
    invoiceId,
    invoiceAttachment: INVOICE_ATTACHMENT.COVERED,
    durationMinutes: 61,
    billedMinutes: 61,
    rateAtEntry: Number.MAX_SAFE_INTEGER,
  });
  expect(
    await getInvoice.handler(context(getInvoice.handler, {}, { invoiceId })),
  ).toMatchObject({ totals: { grossAmountMinor: 1000 } });
});

test("a canonical flat fee cannot accept extra lines, attachments, price edits, or deletion", async () => {
  await setArrangement("flat_fee", 1000);
  const invoiceId = invoiceIdFrom(await draft([]));
  const line = await db.query.invoiceLines.findFirst({
    where: { invoiceId: { eq: invoiceId } },
  });
  if (!line) {
    return panic("Flat fee line missing");
  }
  const entry = await seedEntry();
  const attempts = [
    await createLine.handler(
      context(
        createLine.handler,
        {
          source: {
            type: "manual",
            description: "Extra",
            quantity: "1",
            unitPriceMinor: 1,
          },
          vatRateBps: 0,
          vatTreatment: "domestic_vat",
        },
        { invoiceId },
      ),
    ),
    await addEntries.handler(
      context(addEntries.handler, { timeEntryIds: [entry] }, { invoiceId }),
    ),
    await updateLine.handler(
      context(
        updateLine.handler,
        { unitPriceMinor: 999 },
        { invoiceId, lineId: line.id },
      ),
    ),
    await deleteLine.handler(
      context(deleteLine.handler, {}, { invoiceId, lineId: line.id }),
    ),
  ];
  for (const result of attempts) {
    expect(result).toMatchObject({
      code: 409,
      response: { code: "flat_fee_invoice_locked" },
    });
  }
  expect(
    await db.query.invoiceLines.findMany({
      where: { invoiceId: { eq: invoiceId } },
    }),
  ).toHaveLength(1);
  await deleteInvoice.handler(
    context(deleteInvoice.handler, {}, { invoiceId }),
  );
});

test("hourly draft reservations consume the cap; refused claims roll back and deleting a reservation frees it", async () => {
  await setArrangement("hourly", 1000);
  const first = await seedEntry();
  const second = await seedEntry();
  const invoiceId = invoiceIdFrom(await draft([first]));
  const rejected = await draft([second]);
  expect(rejected).toMatchObject({
    code: 409,
    response: { code: "billing_cap_exceeded" },
  });
  expect(
    await db.query.timeEntries.findFirst({ where: { id: { eq: second } } }),
  ).toMatchObject({
    status: "approved",
    invoiceId: null,
    billedMinutes: 60,
    rateAtEntry: 600,
  });
  expect(
    await db.query.invoices.findMany({
      where: { workspaceId: { eq: ids.wsA2 } },
    }),
  ).toHaveLength(1);
  await deleteInvoice.handler(
    context(deleteInvoice.handler, {}, { invoiceId }),
  );
  expect(await draft([second])).toHaveProperty("id");
});

test("finalize rechecks a lowered cap atomically and void releases covered markers", async () => {
  const entry = await seedEntry();
  const invoiceId = invoiceIdFrom(await draft([entry]));
  await setArrangement("hourly", 500);
  expect(
    await transitionInvoice.handler(
      context(transitionInvoice.handler, { action: "finalize" }, { invoiceId }),
    ),
  ).toMatchObject({ code: 409, response: { code: "billing_cap_exceeded" } });
  expect(
    await db.query.invoices.findFirst({ where: { id: { eq: invoiceId } } }),
  ).toMatchObject({ status: "draft", finalizedAt: null });
  await deleteInvoice.handler(
    context(deleteInvoice.handler, {}, { invoiceId }),
  );
  await setArrangement("flat_fee", 1000);
  const flatId = invoiceIdFrom(await draft([entry]));
  expect(
    await transitionInvoice.handler(
      context(
        transitionInvoice.handler,
        { action: "finalize" },
        { invoiceId: flatId },
      ),
    ),
  ).toHaveProperty("id", flatId);
  expect(
    await transitionInvoice.handler(
      context(
        transitionInvoice.handler,
        { action: "void" },
        { invoiceId: flatId },
      ),
    ),
  ).toHaveProperty("id", flatId);
  expect(
    await db.query.timeEntries.findFirst({ where: { id: { eq: entry } } }),
  ).toMatchObject({
    status: "approved",
    invoiceId: null,
    invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
    rateAtEntry: 600,
  });
});

test("capped invoices refuse foreign-currency time even when its charge is zero", async () => {
  await setArrangement("hourly", 1000);
  const entryId = await seedEntry();
  await db
    .update(timeEntries)
    .set({ currency: "EUR", rateAtEntry: cents(0) })
    .where(eq(timeEntries.id, entryId));
  const result = await createInvoice.handler(
    context(createInvoice.handler, {
      invoiceNumber: `A10-${createSafeId<"invoice">()}`,
      invoiceDate: "2026-09-30",
      currency: "EUR",
      timeEntryIds: [entryId],
    }),
  );
  expect(result).toMatchObject({
    code: 409,
    response: { code: "billing_currency_mismatch" },
  });
  expect(
    await db.query.timeEntries.findFirst({ where: { id: { eq: entryId } } }),
  ).toMatchObject({
    status: "approved",
    invoiceId: null,
    currency: "EUR",
    rateAtEntry: 0,
  });
  expect(
    await db.query.invoices.findMany({
      where: { workspaceId: { eq: ids.wsA2 } },
    }),
  ).toHaveLength(0);
});
