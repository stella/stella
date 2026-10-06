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

import { user as authUser } from "@/api/db/auth-schema";
import {
  billingArrangements,
  INVOICE_ATTACHMENT,
  invoiceLines,
  invoices,
  timeEntries,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
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
    memberRole: sessionMemberRole("owner"),
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
    panic("Flat fee line missing");
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

// Approved work the matter has not invoiced yet, recorded in another currency.
const seedForeignApproved = async () => {
  const id = await seedEntry();
  await db
    .update(timeEntries)
    .set({ currency: "EUR" })
    .where(eq(timeEntries.id, id));
  return id;
};
const invoiceRow = async (invoiceId: SafeId<"invoice">) =>
  await db.query.invoices.findFirst({ where: { id: { eq: invoiceId } } });
const entryRow = async (id: SafeId<"timeEntry">) =>
  await db.query.timeEntries.findFirst({ where: { id: { eq: id } } });
const timeLines = async (invoiceId: SafeId<"invoice">) => {
  const lines = await db.query.invoiceLines.findMany({
    where: { invoiceId: { eq: invoiceId } },
  });
  return lines.filter((line) => line.timeEntryId !== null);
};
const lineFor = async (
  invoiceId: SafeId<"invoice">,
  timeEntryId: SafeId<"timeEntry">,
) => {
  const lines = await timeLines(invoiceId);
  return (
    lines.find((line) => line.timeEntryId === timeEntryId) ??
    panic("Time entry has no invoice line")
  );
};
// A capped hourly draft holding two 600 charges, in a matter that afterwards
// gains approved unbilled work in another currency.
const cappedDraftBesideForeignApprovedWork = async () => {
  await setArrangement("hourly", 2000);
  const first = await seedEntry();
  const second = await seedEntry();
  const invoiceId = invoiceIdFrom(await draft([first, second]));
  const foreign = await seedForeignApproved();
  return { invoiceId, first, second, foreign };
};
const expectForeignWorkUntouched = async (foreign: SafeId<"timeEntry">) => {
  expect(await entryRow(foreign)).toMatchObject({
    status: "approved",
    invoiceId: null,
    currency: "EUR",
  });
};

test("approved work in another currency does not block editing a capped draft's line", async () => {
  const { invoiceId, first, foreign } =
    await cappedDraftBesideForeignApprovedWork();
  const line = await lineFor(invoiceId, first);
  expect(
    await updateLine.handler(
      context(
        updateLine.handler,
        { description: "Reworded narrative" },
        { invoiceId, lineId: line.id },
      ),
    ),
  ).toMatchObject({ id: line.id, totals: { netAmountMinor: 1200 } });
  expect(await lineFor(invoiceId, first)).toMatchObject({
    description: "Reworded narrative",
    netAmount: 600,
  });
  await expectForeignWorkUntouched(foreign);
});

test("approved work in another currency does not block removing an entry from a capped draft", async () => {
  const { invoiceId, first, second, foreign } =
    await cappedDraftBesideForeignApprovedWork();
  expect(
    await removeEntries.handler(
      context(removeEntries.handler, { timeEntryIds: [first] }, { invoiceId }),
    ),
  ).toMatchObject({ success: true });
  expect(await entryRow(first)).toMatchObject({
    status: "approved",
    invoiceId: null,
  });
  expect(await entryRow(second)).toMatchObject({
    status: "billed",
    invoiceId,
  });
  expect(await invoiceRow(invoiceId)).toMatchObject({ netAmount: 600 });
  await expectForeignWorkUntouched(foreign);
});

test("approved work in another currency does not block deleting a capped draft's line", async () => {
  const { invoiceId, first, second, foreign } =
    await cappedDraftBesideForeignApprovedWork();
  const line = await lineFor(invoiceId, first);
  expect(
    await deleteLine.handler(
      context(deleteLine.handler, {}, { invoiceId, lineId: line.id }),
    ),
  ).toMatchObject({ id: line.id, totals: { netAmountMinor: 600 } });
  const remaining = await timeLines(invoiceId);
  expect(remaining.map((row) => row.timeEntryId)).toEqual([second]);
  expect(await invoiceRow(invoiceId)).toMatchObject({ netAmount: 600 });
  await expectForeignWorkUntouched(foreign);
});

test("approved work in another currency does not block adding charges to a capped draft, and the cap still applies", async () => {
  const { invoiceId, foreign } = await cappedDraftBesideForeignApprovedWork();
  const third = await seedEntry();
  expect(
    await addEntries.handler(
      context(addEntries.handler, { timeEntryIds: [third] }, { invoiceId }),
    ),
  ).toHaveProperty("totalAmount");
  expect(await invoiceRow(invoiceId)).toMatchObject({ netAmount: 1800 });
  // 1800 of 2000 is reserved: the next 600 is refused for the cap, not for
  // the currency of the unbilled work.
  const fourth = await seedEntry();
  const capExceeded = {
    code: 409,
    response: { code: "billing_cap_exceeded" },
  };
  expect(
    await addEntries.handler(
      context(addEntries.handler, { timeEntryIds: [fourth] }, { invoiceId }),
    ),
  ).toMatchObject(capExceeded);
  expect(await draft([fourth])).toMatchObject(capExceeded);
  expect(await invoiceRow(invoiceId)).toMatchObject({ netAmount: 1800 });
  await expectForeignWorkUntouched(foreign);
});

test("approved work in another currency does not block drafting or finalizing a capped invoice", async () => {
  const { invoiceId, foreign } = await cappedDraftBesideForeignApprovedWork();
  const third = await seedEntry();
  const secondInvoiceId = invoiceIdFrom(await draft([third]));
  expect(await invoiceRow(secondInvoiceId)).toMatchObject({ netAmount: 600 });
  expect(
    await transitionInvoice.handler(
      context(transitionInvoice.handler, { action: "finalize" }, { invoiceId }),
    ),
  ).toHaveProperty("id", invoiceId);
  expect(await invoiceRow(invoiceId)).toMatchObject({
    status: "finalized",
    netAmount: 1200,
  });
  await expectForeignWorkUntouched(foreign);
  expect(
    await transitionInvoice.handler(
      context(transitionInvoice.handler, { action: "void" }, { invoiceId }),
    ),
  ).toHaveProperty("id", invoiceId);
});

test("approved work in another currency does not block giving an older capped draft its lines", async () => {
  const { invoiceId, first, second, foreign } =
    await cappedDraftBesideForeignApprovedWork();
  // Drafts written before invoice lines existed carry attached entries only;
  // their first line edit writes those lines and recalculates.
  await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  expect(
    await createLine.handler(
      context(
        createLine.handler,
        {
          source: {
            type: "manual",
            description: "Courier",
            quantity: "1",
            unitPriceMinor: 50,
          },
          vatRateBps: 0,
          vatTreatment: "domestic_vat",
        },
        { invoiceId },
      ),
    ),
  ).toMatchObject({ totals: { netAmountMinor: 1250 } });
  const written = await timeLines(invoiceId);
  expect(written).toHaveLength(2);
  expect(new Set(written.map((line) => line.timeEntryId))).toEqual(
    new Set([first, second]),
  );
  expect(await invoiceRow(invoiceId)).toMatchObject({ netAmount: 1250 });
  await expectForeignWorkUntouched(foreign);
});

test("time already invoiced in another currency still blocks changes to a capped draft", async () => {
  // Both drafts predate the cap, so the matter holds invoiced time in two
  // currencies when the cap arrives.
  const first = await seedEntry();
  const invoiceId = invoiceIdFrom(await draft([first]));
  const foreign = await seedForeignApproved();
  const foreignInvoice = await createInvoice.handler(
    context(createInvoice.handler, {
      invoiceNumber: `A10-${createSafeId<"invoice">()}`,
      invoiceDate: "2026-09-30",
      currency: "EUR",
      timeEntryIds: [foreign],
    }),
  );
  if (!("id" in foreignInvoice)) {
    panic(`Invoice failed: ${JSON.stringify(foreignInvoice)}`);
  }
  const foreignInvoiceId = foreignInvoice.id;
  invoiceIds.push(foreignInvoiceId);
  await setArrangement("hourly", 2000);
  const line = await lineFor(invoiceId, first);
  const mismatch = {
    code: 409,
    response: { code: "billing_currency_mismatch" },
  };
  const expectEveryChangeRefused = async () => {
    expect(
      await updateLine.handler(
        context(
          updateLine.handler,
          { description: "Reworded narrative" },
          { invoiceId, lineId: line.id },
        ),
      ),
    ).toMatchObject(mismatch);
    expect(
      await removeEntries.handler(
        context(
          removeEntries.handler,
          { timeEntryIds: [first] },
          { invoiceId },
        ),
      ),
    ).toMatchObject(mismatch);
    expect(
      await transitionInvoice.handler(
        context(
          transitionInvoice.handler,
          { action: "finalize" },
          { invoiceId },
        ),
      ),
    ).toMatchObject(mismatch);
    expect(await draft([await seedEntry()])).toMatchObject(mismatch);
    expect(await lineFor(invoiceId, first)).toMatchObject({
      description: line.description,
    });
    expect(await entryRow(first)).toMatchObject({
      status: "billed",
      invoiceId,
    });
    expect(await invoiceRow(invoiceId)).toMatchObject({
      status: "draft",
      netAmount: 600,
    });
  };
  await expectEveryChangeRefused();
  // The same holds for invoiced time that has no line yet.
  await db
    .delete(invoiceLines)
    .where(eq(invoiceLines.invoiceId, foreignInvoiceId));
  await expectEveryChangeRefused();
});
