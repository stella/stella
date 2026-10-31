import { Result } from "better-result";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  billingArrangements,
  invoiceLines,
  invoices,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { isPgError } from "@/api/lib/pg-error";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import { readBillingUsage, recordBillingCapCrossings } from "./arrangements";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
if (!databaseUrl || !runPostgres) {
  describe.skip("minute cap boundaries and schema combinations (postgres)", () => {
    test("requires the Postgres test configuration", () =>
      expect(true).toBe(true));
  });
} else {
  const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entryId = createSafeId<"timeEntry">();
  const scoped = createScopedDb(
    markRlsDatabase(db),
    [workspaceId],
    organizationId,
    userId,
  );
  const safeDb = createSafeDb(
    markRlsDatabase(db),
    [workspaceId],
    organizationId,
    userId,
  );
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId,
    workspaceId,
    userId,
    execution: {
      performer: { type: "user", id: userId },
      trigger: { type: "system", source: "billing_cap_test" },
    },
  });
  cleanUp(async () => {
    await db.delete(organization).where(eq(organization.id, organizationId));
  });
  cleanUp(async () => {
    await db.delete(user).where(eq(user.id, userId));
  });
  beforeAll(async () => {
    await db.insert(user).values({
      id: userId,
      name: "Billing member",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: organizationId,
      name: "Billing organization",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(member).values({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Billing matter",
      reference: workspaceId,
    });
    await db.insert(workspaceMembers).values({ workspaceId, userId });
  });
  beforeEach(async () => {
    await db.delete(auditLogs).where(eq(auditLogs.workspaceId, workspaceId));
    await scoped(
      async (tx) =>
        await tx
          .delete(invoiceLines)
          .where(eq(invoiceLines.workspaceId, workspaceId)),
    );
    await db
      .delete(timeEntries)
      .where(eq(timeEntries.workspaceId, workspaceId));
    await db.delete(invoices).where(eq(invoices.workspaceId, workspaceId));
    await scoped(
      async (tx) =>
        await tx
          .delete(billingArrangements)
          .where(eq(billingArrangements.workspaceId, workspaceId)),
    );
  });
  const refresh = async () => {
    const result = await safeDb(
      async (tx) =>
        await recordBillingCapCrossings(tx, {
          workspaceId,
          recordAuditEvent,
        }),
    );
    expect(result.isOk()).toBe(true);
    result.unwrap();
  };
  const crossings = async () =>
    (
      await db
        .select({ metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(eq(auditLogs.workspaceId, workspaceId))
    ).filter(({ metadata }) => metadata?.["event"] === "billing_cap_crossed");
  const seed = async ({
    minutes,
    currency = "USD",
    amountCap = null,
  }: {
    minutes: number;
    currency?: string;
    amountCap?: number | null;
  }) => {
    await scoped(
      async (tx) =>
        await tx.insert(billingArrangements).values({
          workspaceId,
          organizationId,
          mode: "hourly",
          currency: "USD",
          capMinutes: 100,
          capAmount: amountCap === null ? null : cents(amountCap),
          alertThresholdBps: 8000,
        }),
    );
    await db.insert(timeEntries).values({
      id: entryId,
      organizationId,
      workspaceId,
      userId,
      dateWorked: "2026-10-04",
      timezoneId: "UTC",
      durationMinutes: minutes,
      billedMinutes: minutes,
      rateAtEntry: cents(1000),
      currency,
      narrative: "Client work",
      status: "approved",
      billable: true,
    });
  };

  const combinations = (["hourly", "flat_fee"] as const).flatMap((mode) =>
    [null, 1000].flatMap((flatFeeAmount) =>
      [null, 10_000].flatMap((capAmount) =>
        [null, 100].flatMap((capMinutes) =>
          [null, 8000].map((alertThresholdBps) => ({
            mode,
            flatFeeAmount,
            capAmount,
            capMinutes,
            alertThresholdBps,
          })),
        ),
      ),
    ),
  );
  const valid = new Set([
    "flat_fee:1000:null:null:null",
    "hourly:null:null:null:null",
    "hourly:null:10000:null:8000",
    "hourly:null:null:100:8000",
    "hourly:null:10000:100:8000",
  ]);
  test.each(combinations)(
    "schema accepts exactly valid $mode fee=$flatFeeAmount amount=$capAmount minutes=$capMinutes threshold=$alertThresholdBps",
    async ({
      mode,
      flatFeeAmount,
      capAmount,
      capMinutes,
      alertThresholdBps,
    }) => {
      const key = [
        mode,
        flatFeeAmount ?? "null",
        capAmount ?? "null",
        capMinutes ?? "null",
        alertThresholdBps ?? "null",
      ].join(":");
      const result = await Result.tryPromise(
        async () =>
          await scoped(
            async (tx) =>
              await tx.execute(sql`
        INSERT INTO ${billingArrangements} (workspace_id, organization_id, mode, currency, flat_fee_amount, cap_amount, cap_minutes, alert_threshold_bps)
        VALUES (${workspaceId}, ${organizationId}, ${mode}, 'USD', ${flatFeeAmount}, ${capAmount}, ${capMinutes}, ${alertThresholdBps})
      `),
          ),
      );
      expect(result.isOk()).toBe(valid.has(key));
      if (result.isErr()) {
        expect(isPgError(result.error, "23514")).toBe(true);
      }
    },
  );
  test.each([
    { minutes: 79, thresholdState: "below", capState: "below", events: 0 },
    { minutes: 80, thresholdState: "above", capState: "below", events: 1 },
    { minutes: 81, thresholdState: "above", capState: "below", events: 1 },
    { minutes: 100, thresholdState: "above", capState: "above", events: 2 },
    { minutes: 101, thresholdState: "above", capState: "above", events: 2 },
  ])(
    "minute cap classifies $minutes minutes and emits each crossing once",
    async ({ minutes, thresholdState, capState, events }) => {
      await seed({ minutes });
      await refresh();
      await refresh();
      const rows = await scoped(
        async (tx) =>
          await tx
            .select()
            .from(billingArrangements)
            .where(eq(billingArrangements.workspaceId, workspaceId)),
      );
      expect(rows.at(0)).toMatchObject({
        minuteThresholdState: thresholdState,
        minuteCapState: capState,
        crossingSequence: events,
      });
      const recorded = await crossings();
      expect(recorded).toHaveLength(events);
      expect(
        recorded.every(({ metadata }) => metadata?.["unit"] === "minutes"),
      ).toBe(true);
    },
  );
  test("minute crossings rearm below threshold and remain independent of amount crossings", async () => {
    await seed({ minutes: 80, amountCap: 10_000 });
    await refresh();
    expect(await crossings()).toHaveLength(1);
    await db
      .update(timeEntries)
      .set({ billedMinutes: 79, durationMinutes: 79 })
      .where(eq(timeEntries.id, entryId));
    await refresh();
    expect(await crossings()).toHaveLength(1);
    await db
      .update(timeEntries)
      .set({ billedMinutes: 100, durationMinutes: 100 })
      .where(eq(timeEntries.id, entryId));
    await refresh();
    expect(await crossings()).toHaveLength(3);
    await db
      .update(timeEntries)
      .set({ rateAtEntry: cents(10_000) })
      .where(eq(timeEntries.id, entryId));
    await refresh();
    await refresh();
    const recorded = await crossings();
    expect(recorded).toHaveLength(5);
    expect(
      recorded.filter(({ metadata }) => metadata?.["unit"] === "minutes"),
    ).toHaveLength(3);
    expect(
      recorded.filter(({ metadata }) => metadata?.["unit"] === "amount"),
    ).toHaveLength(2);
  });
  test("currency mismatch suppresses amount alerts while minute crossings remain exact", async () => {
    await seed({ minutes: 100, currency: "EUR", amountCap: 1000 });
    await refresh();
    await refresh();
    const recorded = await crossings();
    expect(recorded).toHaveLength(2);
    expect(
      recorded.every(({ metadata }) => metadata?.["unit"] === "minutes"),
    ).toBe(true);
    const rows = await scoped(
      async (tx) =>
        await tx
          .select()
          .from(billingArrangements)
          .where(eq(billingArrangements.workspaceId, workspaceId)),
    );
    expect(rows.at(0)).toMatchObject({
      currencyState: "mismatch",
      thresholdState: "below",
      capState: "below",
      minuteThresholdState: "above",
      minuteCapState: "above",
    });
    const audits = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.workspaceId, workspaceId));
    expect(
      audits.filter(
        ({ metadata }) => metadata?.["event"] === "billing_currency_mismatch",
      ),
    ).toHaveLength(1);
  });
  test.each([
    { name: "zero minutes", mutation: sql`cap_minutes = 0` },
    { name: "negative minutes", mutation: sql`cap_minutes = -1` },
    { name: "missing threshold", mutation: sql`alert_threshold_bps = NULL` },
    { name: "threshold below range", mutation: sql`alert_threshold_bps = 0` },
    {
      name: "threshold above range",
      mutation: sql`alert_threshold_bps = 10001`,
    },
    {
      name: "invalid minute state",
      mutation: sql`minute_cap_state = 'unknown'`,
    },
  ])("minute schema refuses $name", async ({ mutation }) => {
    await seed({ minutes: 1 });
    const result = await Result.tryPromise(
      async () =>
        await scoped(
          async (tx) =>
            await tx.execute(
              sql`UPDATE ${billingArrangements} SET ${mutation} WHERE workspace_id = ${workspaceId}`,
            ),
        ),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(isPgError(result.error, "23514")).toBe(true);
    }
  });
  const reservedUsage = async () =>
    (
      await safeDb(
        async (tx) =>
          await readBillingUsage(tx, { workspaceId, currency: "USD" }),
      )
    ).unwrap();
  const attachInvoice = async ({
    attachment,
    billingMode,
  }: {
    attachment: "charged" | "covered";
    billingMode: "hourly" | "flat_fee";
  }) => {
    const invoiceId = createSafeId<"invoice">();
    await db.insert(invoices).values({
      id: invoiceId,
      workspaceId,
      organizationId,
      invoiceDate: "2026-10-04",
      currency: "USD",
      status: "draft",
      billingMode,
      flatFeeAmount: billingMode === "flat_fee" ? cents(1000) : null,
    });
    await db
      .update(timeEntries)
      .set({ invoiceId, status: "billed", invoiceAttachment: attachment })
      .where(eq(timeEntries.id, entryId));
    return invoiceId;
  };
  const materializeReservation = async (invoiceId: SafeId<"invoice">) => {
    const lineId = createSafeId<"invoiceLine">();
    const inserted = await scoped(
      async (tx) =>
        await tx
          .insert(invoiceLines)
          .values({
            id: lineId,
            invoiceId,
            workspaceId,
            organizationId,
            position: 0,
            description: "Client work",
            quantity: "1.0000",
            unitPrice: cents(1000),
            netAmount: cents(1000),
            vatAmount: cents(0),
            grossAmount: cents(1000),
            vatRateBps: 0,
            vatTreatment: "not_vat_payer",
            source: "time_entry",
            timeEntryId: entryId,
          })
          .returning({ id: invoiceLines.id }),
    );
    expect(inserted).toEqual([{ id: lineId }]);
    return lineId;
  };

  test("covered materialized time remains outside later hourly caps and charged snapshots count", async () => {
    await seed({ minutes: 60 });
    await scoped(
      async (tx) =>
        await tx
          .update(billingArrangements)
          .set({
            mode: "flat_fee",
            flatFeeAmount: cents(1000),
            capMinutes: null,
            alertThresholdBps: null,
          })
          .where(eq(billingArrangements.workspaceId, workspaceId)),
    );
    const invoiceId = await attachInvoice({
      attachment: "covered",
      billingMode: "flat_fee",
    });
    const lineId = await materializeReservation(invoiceId);
    expect(
      await scoped(
        async (tx) =>
          await tx
            .update(invoiceLines)
            .set({
              quantity: "2.0000",
              unitPrice: cents(2500),
              netAmount: cents(5000),
              grossAmount: cents(5000),
            })
            .where(eq(invoiceLines.id, lineId))
            .returning({ id: invoiceLines.id }),
      ),
    ).toEqual([{ id: lineId }]);
    await scoped(
      async (tx) =>
        await tx
          .update(billingArrangements)
          .set({
            mode: "hourly",
            flatFeeAmount: null,
            capMinutes: 100,
            capAmount: cents(10_000),
            alertThresholdBps: 8000,
          })
          .where(eq(billingArrangements.workspaceId, workspaceId)),
    );
    expect(await reservedUsage()).toMatchObject({
      billedAmount: 0n,
      billedMinutes: 0n,
      mismatchCount: 0n,
    });
    await refresh();
    expect(await crossings()).toHaveLength(0);
    await db
      .update(invoices)
      .set({ billingMode: "hourly", flatFeeAmount: null })
      .where(eq(invoices.id, invoiceId));
    await db
      .update(timeEntries)
      .set({ invoiceAttachment: "charged" })
      .where(eq(timeEntries.id, entryId));
    expect(await reservedUsage()).toMatchObject({
      billedAmount: 5000n,
      billedMinutes: 120n,
    });
    await refresh();
    expect(await crossings()).toHaveLength(2);
  });

  test("legacy and materialized charged reservations agree while snapshots own adjusted amounts and minutes", async () => {
    await seed({ minutes: 60 });
    const invoiceId = await attachInvoice({
      attachment: "charged",
      billingMode: "hourly",
    });
    const legacy = await reservedUsage();
    expect(legacy).toMatchObject({ billedAmount: 1000n, billedMinutes: 60n });
    const lineId = await materializeReservation(invoiceId);
    expect(await reservedUsage()).toEqual(legacy);
    expect(
      await scoped(
        async (tx) =>
          await tx
            .update(invoiceLines)
            .set({
              quantity: "1.5000",
              unitPrice: cents(2000),
              netAmount: cents(3000),
              grossAmount: cents(3000),
            })
            .where(eq(invoiceLines.id, lineId))
            .returning({ id: invoiceLines.id }),
      ),
    ).toEqual([{ id: lineId }]);
    expect(await reservedUsage()).toMatchObject({
      billedAmount: 3000n,
      billedMinutes: 90n,
    });
    await db
      .update(invoices)
      .set({ status: "void" })
      .where(eq(invoices.id, invoiceId));
    expect(await reservedUsage()).toMatchObject({
      billedAmount: 0n,
      billedMinutes: 0n,
    });
    await db
      .update(invoices)
      .set({ status: "draft" })
      .where(eq(invoices.id, invoiceId));
    expect(await reservedUsage()).toMatchObject({
      billedAmount: 3000n,
      billedMinutes: 90n,
    });
    expect(
      await scoped(
        async (tx) =>
          await tx
            .update(invoiceLines)
            .set({ releasedAt: new Date() })
            .where(eq(invoiceLines.id, lineId))
            .returning({ id: invoiceLines.id }),
      ),
    ).toEqual([{ id: lineId }]);
    await db
      .update(timeEntries)
      .set({
        invoiceId: null,
        invoiceAttachment: "charged",
        status: "approved",
      })
      .where(eq(timeEntries.id, entryId));
    expect(await reservedUsage()).toMatchObject({
      billedAmount: 0n,
      billedMinutes: 0n,
      approvedAmount: 1000n,
      approvedMinutes: 60n,
    });
  });

  test("the application role cannot directly execute the private reserved-time aggregate", async () => {
    const result = await Result.tryPromise(
      async () =>
        await scoped(
          async (tx) =>
            await tx.execute(
              sql`SELECT * FROM public.stella_matter_reserved_time(${workspaceId}, 'USD', NULL)`,
            ),
        ),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(isPgError(result.error, "42501")).toBe(true);
    }
  });
}
