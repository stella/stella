import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  billingArrangements,
  invoices,
  invoiceLines,
  timeEntries,
  workspaces,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import {
  recordBillingCapCrossings,
  recordBillingCapCrossingsForMatters,
} from "@/api/lib/billing/arrangements";
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
import getSummary from "./summary/get";
import setArrangement from "./update";

setDefaultTimeout(120_000);
let db: TestDatabase;
let ids: TestIds;
const workspaceId = createSafeId<"workspace">();
const secondWorkspaceId = createSafeId<"workspace">();
const testWorkspaceIds = [workspaceId, secondWorkspaceId];
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

  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1, ids.userAdmin]));
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
        userId: ids.userAdmin,
        featureId: "time-billing",
      },
      {
        organizationId: ids.orgB,
        userId: ids.userA1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
  await db.insert(workspaces).values(
    testWorkspaceIds.map((id) => ({
      id,
      organizationId: ids.orgA,
      name: "Billing arrangement test",
      reference: id,
    })),
  );
});
const cleanup = async () => {
  await db
    .delete(auditLogs)
    .where(inArray(auditLogs.workspaceId, testWorkspaceIds));
  await db
    .delete(invoiceLines)
    .where(inArray(invoiceLines.workspaceId, testWorkspaceIds));
  await db
    .delete(timeEntries)
    .where(inArray(timeEntries.workspaceId, testWorkspaceIds));
  await db
    .delete(invoices)
    .where(inArray(invoices.workspaceId, testWorkspaceIds));
  await db
    .delete(billingArrangements)
    .where(inArray(billingArrangements.workspaceId, testWorkspaceIds));
};
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.delete(workspaces).where(inArray(workspaces.id, testWorkspaceIds));
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
      createAuditRecorder: audit,
      body,
    }),
  );
const summary = async () => {
  const response = await getSummary.handler(
    createTestHandlerContext<Parameters<typeof getSummary.handler>[0]>({
      workspaceId,
      safeDb: safeDb(),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
    }),
  );
  if (!("summary" in response)) {
    panic("Billing summary request was refused");
  }
  return response.summary;
};
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
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
    }),
  );
  expect(result).toEqual({ arrangement: null });
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
  expect(
    events
      .map((row) => {
        const sequence = row.metadata?.["sequence"];
        if (typeof sequence !== "number") {
          panic("Crossing audit sequence missing");
        }
        return sequence;
      })
      .toSorted((left, right) => left - right),
  ).toEqual([1, 2, 3]);
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
        session: { activeOrganizationId: ids.orgB },
        user: { id: ids.userA1 },
      }),
    ),
  ).toEqual({ arrangement: null });
  const result = await setArrangement.handler(
    createTestHandlerContext<Parameters<typeof setArrangement.handler>[0]>({
      workspaceId,
      safeDb: foreign,
      session: { activeOrganizationId: ids.orgB },
      user: { id: ids.userA1 },
      body: { mode: "flat_fee", currency: "USD", flatFeeAmount: 1 },
    }),
  );
  expect(result).toMatchObject({
    code: 404,
    response: { message: "Workspace not found" },
  });
  expect(
    await getArrangement.handler(
      createTestHandlerContext<Parameters<typeof getArrangement.handler>[0]>({
        workspaceId,
        safeDb: safeDb(),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userAdmin },
      }),
    ),
  ).toMatchObject({ arrangement: capped });
});

test("batched matter reconciliation keeps currencies separate and emits each upward boundary once", async () => {
  await db.insert(billingArrangements).values(
    testWorkspaceIds.map((id) => ({
      workspaceId: id,
      organizationId: ids.orgA,
      ...capped,
      capAmount: cents(capped.capAmount),
    })),
  );
  await seedApproved(8000);
  const reservations = [
    { workspaceId, amount: 2000 },
    { workspaceId: secondWorkspaceId, amount: 1000 },
  ].map(({ workspaceId: matterId, amount }) => ({
    workspaceId: matterId,
    amount,
    invoiceId: createSafeId<"invoice">(),
    entryId: createSafeId<"timeEntry">(),
  }));
  await db.insert(invoices).values(
    reservations.map((reservation) => ({
      id: reservation.invoiceId,
      workspaceId: reservation.workspaceId,
      organizationId: ids.orgA,
      invoiceDate: "2026-10-04",
      currency: "USD",
      status: "draft" as const,
    })),
  );
  await db.insert(timeEntries).values(
    reservations.map((reservation) => ({
      id: reservation.entryId,
      workspaceId: reservation.workspaceId,
      organizationId: ids.orgA,
      invoiceId: reservation.invoiceId,
      userId: ids.userAdmin,
      dateWorked: "2026-10-04",
      timezoneId: "UTC",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: cents(reservation.amount),
      currency: "USD",
      narrative: "Reserved client work",
      status: "billed" as const,
      billable: true,
    })),
  );
  await db.insert(invoiceLines).values(
    reservations.map((reservation) => ({
      invoiceId: reservation.invoiceId,
      workspaceId: reservation.workspaceId,
      organizationId: ids.orgA,
      position: 0,
      description: "Reserved client work",
      quantity: "1.0000",
      unitPrice: cents(reservation.amount),
      netAmount: cents(reservation.amount),
      vatAmount: cents(0),
      grossAmount: cents(reservation.amount),
      vatRateBps: 0,
      vatTreatment: "not_vat_payer" as const,
      source: "time_entry" as const,
      timeEntryId: reservation.entryId,
    })),
  );
  const secondEntryId = createSafeId<"timeEntry">();
  await db.insert(timeEntries).values({
    id: secondEntryId,
    organizationId: ids.orgA,
    workspaceId: secondWorkspaceId,
    userId: ids.userAdmin,
    dateWorked: "2026-10-04",
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(8000),
    currency: "EUR",
    narrative: "Other matter work",
    status: "approved",
    billable: true,
  });
  const scoped = asTestRaw<SafeDb>(
    createSafeDb(db, testWorkspaceIds, ids.orgA, ids.userAdmin),
  );
  const refresh = async () =>
    await scoped(
      async (tx) =>
        await recordBillingCapCrossingsForMatters(tx, {
          workspaceIds: [secondWorkspaceId, workspaceId, secondWorkspaceId],
          recordAuditEvent: audit(),
        }),
    );
  expect((await refresh()).isOk()).toBe(true);
  expect((await refresh()).isOk()).toBe(true);
  const initial = await db
    .select()
    .from(billingArrangements)
    .where(inArray(billingArrangements.workspaceId, testWorkspaceIds));
  expect(initial.find((row) => row.workspaceId === workspaceId)).toMatchObject({
    capState: "above",
    crossingSequence: 2,
  });
  expect(
    initial.find((row) => row.workspaceId === secondWorkspaceId),
  ).toMatchObject({
    currencyState: "mismatch",
    capState: "below",
    crossingSequence: 0,
  });
  const events = await db
    .select()
    .from(auditLogs)
    .where(inArray(auditLogs.workspaceId, testWorkspaceIds));
  expect(events).toHaveLength(3);
  const firstCrossings = events.filter(
    (row) => row.workspaceId === workspaceId,
  );
  expect(firstCrossings).toHaveLength(2);
  expect(
    firstCrossings.every((row) => row.metadata?.["usedAmount"] === "10000"),
  ).toBe(true);
  expect(
    events.find((row) => row.workspaceId === secondWorkspaceId)?.metadata,
  ).toMatchObject({ event: "billing_currency_mismatch" });
  await db
    .update(timeEntries)
    .set({ currency: "USD" })
    .where(eq(timeEntries.id, secondEntryId));
  expect((await refresh()).isOk()).toBe(true);
  expect((await refresh()).isOk()).toBe(true);
  const reconciled = await db.query.billingArrangements.findFirst({
    where: { workspaceId: { eq: secondWorkspaceId } },
  });
  expect(reconciled).toMatchObject({
    currencyState: "matched",
    thresholdState: "above",
    capState: "below",
    crossingSequence: 1,
  });
  const finalEvents = await db
    .select()
    .from(auditLogs)
    .where(inArray(auditLogs.workspaceId, testWorkspaceIds));
  expect(finalEvents).toHaveLength(4);
  expect(
    finalEvents.find(
      (row) =>
        row.workspaceId === secondWorkspaceId &&
        row.metadata?.["event"] === "billing_cap_crossed",
    )?.metadata,
  ).toMatchObject({ usedAmount: "9000", boundary: "threshold" });
});

test("an audit failure rolls back crossing state and its audit rows together", async () => {
  await set(capped);
  await seedApproved(10_000);
  await db.insert(billingArrangements).values({
    workspaceId: secondWorkspaceId,
    organizationId: ids.orgA,
    ...capped,
    capAmount: cents(capped.capAmount),
  });
  await db.insert(timeEntries).values({
    id: createSafeId<"timeEntry">(),
    organizationId: ids.orgA,
    workspaceId: secondWorkspaceId,
    userId: ids.userAdmin,
    dateWorked: "2026-10-04",
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(10_000),
    currency: "USD",
    narrative: "Other matter work",
    status: "approved",
    billable: true,
  });
  const scoped = asTestRaw<SafeDb>(
    createSafeDb(db, testWorkspaceIds, ids.orgA, ids.userAdmin),
  );
  const result = await scoped(
    async (tx) =>
      await recordBillingCapCrossingsForMatters(tx, {
        workspaceIds: testWorkspaceIds,
        recordAuditEvent: async (auditTx, events) => {
          await audit()(auditTx, events);
          panic("Audit unavailable for rollback fixture");
        },
      }),
  );
  expect(result.isErr()).toBe(true);
  expect(
    await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.workspaceId, testWorkspaceIds)),
  ).toHaveLength(1);
  const rows = await db
    .select()
    .from(billingArrangements)
    .where(inArray(billingArrangements.workspaceId, testWorkspaceIds));
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (row) =>
        row.thresholdState === "below" &&
        row.capState === "below" &&
        row.crossingSequence === 0,
    ),
  ).toBe(true);
  expect((await refreshCrossings()).isOk()).toBe(true);
  expect(await crossingEvents()).toHaveLength(2);
});

test("GET configuration can be resent unchanged and stale revisions are refused", async () => {
  await set(capped);
  const context = createTestHandlerContext<
    Parameters<typeof getArrangement.handler>[0]
  >({
    workspaceId,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userAdmin },
    safeDb: safeDb(),
  });
  const response = await getArrangement.handler(context);
  if (!("arrangement" in response)) {
    panic("Billing arrangement request was refused");
  }
  const readback = response.arrangement;
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
