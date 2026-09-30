import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  billingArrangements,
  invoices,
  invoiceLines,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { isPgError } from "@/api/lib/pg-error";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import getArrangement from "./get";
import setArrangement from "./set";
import getSummary from "./summary";

setDefaultTimeout(120_000);
let db: TestDatabase;
let ids: TestIds;
const workspaceId = createSafeId<"workspace">();
const entryId = createSafeId<"timeEntry">();
const capped = {
  mode: "hourly",
  currency: "USD",
  capAmount: 10_000,
  alertThresholdBps: 8000,
} as const;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    name: "Billing arrangement test",
    reference: workspaceId,
  });
});
const cleanup = async () => {
  await db.delete(auditLogs).where(eq(auditLogs.workspaceId, workspaceId));
  await db.delete(timeEntries).where(eq(timeEntries.workspaceId, workspaceId));
  await db.delete(invoices).where(eq(invoices.workspaceId, workspaceId));
  await db
    .delete(billingArrangements)
    .where(eq(billingArrangements.workspaceId, workspaceId));
};
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await releaseRlsFixture();
});

const safeDb = () =>
  asTestRaw<SafeDb>(createSafeDb(db, [workspaceId], ids.orgA, ids.userAdmin));
const audit = () =>
  createAuditRecorder({
    organizationId: ids.orgA,
    workspaceId,
    userId: ids.userAdmin,
    request: new Request("https://example.test/rates/arrangement"),
    server: null,
  });
const set = async (
  body: Parameters<typeof setArrangement.handler>[0]["body"],
) =>
  await setArrangement.handler(
    createTestHandlerContext<Parameters<typeof setArrangement.handler>[0]>({
      workspaceId,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
      safeDb: safeDb(),
      recordAuditEvent: audit(),
      body,
    }),
  );
const summary = async () =>
  await getSummary.handler(
    createTestHandlerContext<Parameters<typeof getSummary.handler>[0]>({
      workspaceId,
      safeDb: safeDb(),
    }),
  );
const refreshCrossings = async () =>
  await safeDb()(
    async (tx) =>
      await recordBillingCapCrossings(tx, {
        workspaceId,
        recordAuditEvent: audit(),
      }),
  );
const seedApproved = async (rate: number, currency = "USD") =>
  await db.insert(timeEntries).values({
    id: entryId,
    organizationId: ids.orgA,
    workspaceId,
    userId: ids.userAdmin,
    dateWorked: "2026-10-04",
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(rate),
    currency,
    narrative: "Client work",
    status: "approved",
    billable: true,
  });
const crossingEvents = async () =>
  (
    await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.workspaceId, workspaceId))
  ).filter((row) => row.metadata?.["event"] === "billing_cap_crossed");

test("missing billing arrangements preserve the existing hourly default without inventing a currency", async () => {
  const result = await getArrangement.handler(
    createTestHandlerContext<Parameters<typeof getArrangement.handler>[0]>({
      workspaceId,
      safeDb: safeDb(),
    }),
  );
  expect(result).toBeNull();
  expect(await summary()).toBeNull();
});

test("setting a flat fee records one bounded minor-unit arrangement and an identical retry is unchanged", async () => {
  const body = {
    mode: "flat_fee",
    currency: "USD",
    flatFeeAmount: 12_345,
  } as const;
  expect(await set(body)).toMatchObject({ ...body, revision: 1 });
  expect(await set(body)).toMatchObject({ revision: 1 });
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.workspaceId, workspaceId));
  expect(rows).toHaveLength(1);
  expect(rows.at(0)).toMatchObject({
    userId: ids.userAdmin,
    resourceId: workspaceId,
    workspaceId,
  });
});

test("cap events occur once per upward crossing and reset after value decreases", async () => {
  await set(capped);
  await seedApproved(8000);
  expect((await refreshCrossings()).isOk()).toBe(true);
  expect((await refreshCrossings()).isOk()).toBe(true);
  expect(await crossingEvents()).toHaveLength(1);
  expect(await summary()).toMatchObject({
    status: "threshold_reached",
    approvedAmount: "8000",
    billedAmount: "0",
    remainingWipCapAmount: "2000",
  });
  expect(await crossingEvents()).toHaveLength(1);
  await db
    .update(timeEntries)
    .set({ rateAtEntry: cents(7999) })
    .where(eq(timeEntries.id, entryId));
  expect((await refreshCrossings()).isOk()).toBe(true);
  await db
    .update(timeEntries)
    .set({ rateAtEntry: cents(10_000) })
    .where(eq(timeEntries.id, entryId));
  expect((await refreshCrossings()).isOk()).toBe(true);
  const events = await crossingEvents();
  expect(events).toHaveLength(3);
  expect(events.map((row) => row.metadata?.["sequence"]).toSorted()).toEqual([
    1, 2, 3,
  ]);
  expect(
    events.filter((row) => row.metadata?.["boundary"] === "threshold"),
  ).toHaveLength(2);
  expect(await summary()).toMatchObject({
    status: "cap_reached",
    remainingWipCapAmount: "0",
  });
});

test("mixed-currency approved work remains recordable but cap status is unavailable and mismatch is audited once", async () => {
  await set(capped);
  await seedApproved(5000, "EUR");
  expect((await refreshCrossings()).isOk()).toBe(true);
  expect((await refreshCrossings()).isOk()).toBe(true);
  expect(await summary()).toEqual({
    status: "currency_mismatch",
    currency: "USD",
    mismatchCount: "1",
    capStatus: "unavailable",
  });
  const rows = await db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(eq(auditLogs.workspaceId, workspaceId));
  expect(
    rows.filter(
      (row) => row.metadata?.["event"] === "billing_currency_mismatch",
    ),
  ).toHaveLength(1);
  expect(await set({ ...capped, capAmount: 20_000 })).toMatchObject({
    code: 409,
    response: { code: "billing_currency_mismatch" },
  });
});

test("another organization cannot read or replace an arrangement under a foreign matter pin", async () => {
  await set(capped);
  const foreign = asTestRaw<SafeDb>(
    createSafeDb(db, [workspaceId], ids.orgB, ids.userA1),
  );
  expect(
    await getArrangement.handler(
      createTestHandlerContext<Parameters<typeof getArrangement.handler>[0]>({
        workspaceId,
        safeDb: foreign,
      }),
    ),
  ).toBeNull();
  const result = await setArrangement.handler(
    createTestHandlerContext<Parameters<typeof setArrangement.handler>[0]>({
      workspaceId,
      safeDb: foreign,
      session: { activeOrganizationId: ids.orgB },
      user: { id: ids.userA1 },
      body: { mode: "flat_fee", currency: "USD", flatFeeAmount: 1 },
    }),
  );
  expect(result).toMatchObject({ code: 400 });
  expect(
    await getArrangement.handler(
      createTestHandlerContext<Parameters<typeof getArrangement.handler>[0]>({
        workspaceId,
        safeDb: safeDb(),
      }),
    ),
  ).toMatchObject(capped);
});

test("an audit failure rolls back crossing state and its audit rows together", async () => {
  await set(capped);
  await seedApproved(10_000);
  const result = await safeDb()(
    async (tx) =>
      await recordBillingCapCrossings(tx, {
        workspaceId,
        recordAuditEvent: async (auditTx, events) => {
          await audit()(auditTx, events);
          panic("Audit unavailable for rollback fixture");
        },
      }),
  );
  expect(result.isErr()).toBe(true);
  expect(await crossingEvents()).toHaveLength(0);
  const rows = await db
    .select()
    .from(billingArrangements)
    .where(eq(billingArrangements.workspaceId, workspaceId));
  expect(rows.at(0)).toMatchObject({
    thresholdState: "below",
    capState: "below",
    crossingSequence: 0,
  });
  expect((await refreshCrossings()).isOk()).toBe(true);
  expect(await crossingEvents()).toHaveLength(2);
});

test("GET configuration can be resent unchanged and stale revisions are refused", async () => {
  await set(capped);
  const context = createTestHandlerContext<
    Parameters<typeof getArrangement.handler>[0]
  >({ workspaceId, safeDb: safeDb() });
  const readback = await getArrangement.handler(context);
  expect(readback).not.toBeNull();
  if (!readback) {
    panic("Configured arrangement unexpectedly missing");
  }
  expect(await set(readback)).toEqual(readback);
  await set({ mode: "hourly", currency: "USD" });
  expect(await set(readback)).toMatchObject({
    code: 409,
    response: { code: "billing_arrangement_stale" },
  });
});

test.each([
  {
    name: "missing flat fee",
    mutation: sql`mode = 'flat_fee', flat_fee_amount = NULL, cap_amount = NULL, alert_threshold_bps = NULL`,
  },
  { name: "missing threshold", mutation: sql`alert_threshold_bps = NULL` },
  { name: "zero cap", mutation: sql`cap_amount = 0` },
  {
    name: "negative flat fee",
    mutation: sql`mode = 'flat_fee', flat_fee_amount = -1, cap_amount = NULL, alert_threshold_bps = NULL`,
  },
  {
    name: "out of range threshold",
    mutation: sql`alert_threshold_bps = 10001`,
  },
  { name: "unsafe minor units", mutation: sql`cap_amount = 9007199254740992` },
  { name: "invalid currency", mutation: sql`currency = 'usd'` },
  { name: "invalid crossing state", mutation: sql`currency_state = 'unknown'` },
])("billing arrangement CHECK rejects $name", async ({ mutation }) => {
  await set(capped);
  const result = await Result.tryPromise(
    async () =>
      await db.execute(
        sql`UPDATE ${billingArrangements} SET ${mutation} WHERE workspace_id = ${workspaceId}`,
      ),
  );
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(isPgError(result.error, "23514")).toBe(true);
  }
});

test("legacy draft time reservations are counted once before and after line materialization, while covered time and void invoices do not consume the cap", async () => {
  await set(capped);
  await seedApproved(8000);
  const invoiceId = createSafeId<"invoice">();
  await db.insert(invoices).values({
    id: invoiceId,
    workspaceId,
    organizationId: ids.orgA,
    invoiceDate: "2026-10-04",
    currency: "USD",
    status: "draft",
  });
  await db
    .update(timeEntries)
    .set({ invoiceId, status: "billed", invoiceAttachment: "charged" })
    .where(eq(timeEntries.id, entryId));
  expect(await summary()).toMatchObject({
    billedAmount: "8000",
    approvedAmount: "0",
    remainingInvoiceCapAmount: "2000",
    remainingWipCapAmount: "2000",
  });
  expect(await set({ ...capped, capAmount: 7999 })).toMatchObject({
    code: 409,
    response: { code: "billing_cap_below_reserved" },
  });
  await db.insert(invoiceLines).values({
    invoiceId,
    workspaceId,
    organizationId: ids.orgA,
    position: 0,
    description: "Client work",
    quantity: "1.0000",
    unitPrice: cents(8000),
    netAmount: cents(8000),
    vatAmount: cents(0),
    grossAmount: cents(8000),
    vatRateBps: 0,
    vatTreatment: "not_vat_payer",
    source: "time_entry",
    timeEntryId: entryId,
  });
  expect(await summary()).toMatchObject({
    billedAmount: "8000",
    totalAmount: "8000",
  });
  await db
    .update(invoices)
    .set({ status: "void" })
    .where(eq(invoices.id, invoiceId));
  expect(await summary()).toMatchObject({
    billedAmount: "0",
    totalAmount: "0",
  });
  await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  await db
    .update(invoices)
    .set({
      status: "draft",
      billingMode: "flat_fee",
      flatFeeAmount: cents(1000),
    })
    .where(eq(invoices.id, invoiceId));
  await db
    .update(timeEntries)
    .set({ invoiceAttachment: "covered" })
    .where(eq(timeEntries.id, entryId));
  expect(await summary()).toMatchObject({
    billedAmount: "0",
    totalAmount: "0",
  });
});
