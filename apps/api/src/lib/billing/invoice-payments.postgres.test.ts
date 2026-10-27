import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  INVOICE_STATUS,
  invoicePayments,
  invoices,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { recordInvoicePayment } from "@/api/lib/billing/invoice-payments";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  type InterleavingResult,
  withInterleaving,
} from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const TOTAL = 10_000;

type Fixture = {
  /** The database owner: seeds invoices; payments force RLS even for it. */
  db: GatedTestDb;
  /** Runs as the application role scoped to the fixture's owner. */
  asApp: <T>(run: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** One connection per interleaved actor. */
  actors: Record<"a" | "b", GatedTestDb>;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  invoiceId: SafeId<"invoice">;
  recordAuditEvent: AuditRecorder;
};

// One owner, one matter and one sent invoice of TOTAL minor units.
const withFixture = async (
  url: string,
  run: (fixture: Fixture) => Promise<void>,
) =>
  await withGatedTestClients(url, async ({ openClient }) => {
    const { db } = openClient({ max: 1 });
    const actors = {
      a: openClient({ max: 1 }).db,
      b: openClient({ max: 1 }).db,
    };
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const invoiceId = createSafeId<"invoice">();
    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId,
      workspaceId: null,
      userId,
      execution: {
        performer: { type: "user", id: userId },
        trigger: { type: "system", source: "invoice_payment_lock_test" },
      },
    });
    try {
      await db.insert(user).values({
        id: userId,
        name: "Payment test member",
        email: `${userId}@example.test`,
        emailVerified: true,
      });
      await db.insert(organization).values({
        id: organizationId,
        name: "Payment test organization",
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
        name: "Payment test matter",
        reference: workspaceId,
      });
      await db.insert(workspaceMembers).values({ workspaceId, userId });
      await db.insert(invoices).values({
        id: invoiceId,
        organizationId,
        workspaceId,
        invoiceNumber: "PAY-LOCK-1",
        invoiceDate: "2026-06-23",
        currency: "EUR",
        status: INVOICE_STATUS.SENT,
        totalAmount: cents(TOTAL),
      });
      const asApp = createScopedDb(
        markRlsDatabase(db),
        [workspaceId],
        organizationId,
        userId,
      );
      await run({
        db,
        asApp: async (work) => await asApp(work),
        actors,
        organizationId,
        userId,
        workspaceId,
        invoiceId,
        recordAuditEvent,
      });
    } finally {
      // Payments restrict their invoice; the organization cascade takes both.
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    }
  });

// Each actor runs its payment as the application role, as a request would.
const payingActor = (fixture: Fixture, actor: "a" | "b", amount: number) => {
  const safeDb = createSafeDb(
    markRlsDatabase(fixture.actors[actor]),
    [fixture.workspaceId],
    fixture.organizationId,
    fixture.userId,
  );
  return {
    steps: [
      {
        name: "pay",
        run: async (tx: Transaction) =>
          await recordInvoicePayment(
            tx,
            {
              invoiceId: fixture.invoiceId,
              workspaceId: fixture.workspaceId,
              organizationId: fixture.organizationId,
              userId: fixture.userId,
              now: new Date(),
              recordAuditEvent: fixture.recordAuditEvent,
            },
            {
              amount,
              paidOn: Temporal.Now.plainDateISO("UTC")
                .subtract({ days: 1 })
                .toString(),
              method: "bank_transfer",
              reference: null,
              note: null,
            },
          ),
      },
    ],
    transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
      (
        await safeDb(run, {
          retry: { times: 0, delayMs: 0, backoff: "constant" },
        })
      ).unwrap(),
  };
};

const readState = async ({ db, asApp, invoiceId }: Fixture) => {
  const [invoice] = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  const payments = await asApp(
    async (tx) =>
      await tx
        .select({ amount: invoicePayments.amount })
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.invoiceId, invoiceId),
            isNull(invoicePayments.voidedAt),
          ),
        ),
  );
  return {
    status: invoice?.status,
    paid: payments.reduce((sum, payment) => sum + payment.amount, 0),
    payments: payments.length,
  };
};

const reset = (fixture: Fixture) => async () => {
  await fixture.db
    .delete(auditLogs)
    .where(eq(auditLogs.organizationId, fixture.organizationId));
  // Payments are never deleted: the previous order's ones are voided.
  await fixture.asApp(
    async (tx) =>
      await tx
        .update(invoicePayments)
        .set({ voidedAt: new Date(), voidedBy: fixture.userId })
        .where(
          and(
            eq(invoicePayments.invoiceId, fixture.invoiceId),
            isNull(invoicePayments.voidedAt),
          ),
        ),
  );
  await fixture.db
    .update(invoices)
    .set({ status: INVOICE_STATUS.SENT, paidAt: null })
    .where(eq(invoices.id, fixture.invoiceId));
};

const COMMITTED: InterleavingResult<unknown>["outcomes"] = {
  a: { status: "committed" },
  b: { status: "committed" },
};

if (!databaseUrl || !runPostgres) {
  describe.skip("recording invoice payments concurrently (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  // Each payment alone fits the outstanding amount; together they would pay
  // 120 % of the invoice. The invoice lock makes the second one read the
  // first one's payment, so it is refused in every order.
  test("two concurrent payments can never overpay an invoice", async () => {
    await withFixture(databaseUrl, async (fixture) => {
      const results = await withInterleaving({
        databaseUrl,
        a: payingActor(fixture, "a", 6000),
        b: payingActor(fixture, "b", 6000),
        reset: reset(fixture),
        readState: async () => await readState(fixture),
        invariant: ({ outcomes, state }) => {
          expect(outcomes).toEqual(COMMITTED);
          expect(state).toEqual({
            status: INVOICE_STATUS.SENT,
            paid: 6000,
            payments: 1,
          });
        },
      });
      // One step and one commit each: six orders.
      expect(results).toHaveLength(6);
      // The first payment's uncommitted lock made the second one wait.
      expect(results.some(({ blocked }) => blocked.length > 0)).toBe(true);
    });
  }, 60_000); // timeout: six interleavings, each with its own pair of real Postgres sessions and lock waits

  // Two payments that together settle the invoice both land, and whichever
  // commits second marks it paid.
  test("two concurrent payments that settle the invoice mark it paid exactly once", async () => {
    await withFixture(databaseUrl, async (fixture) => {
      const results = await withInterleaving({
        databaseUrl,
        a: payingActor(fixture, "a", 4000),
        b: payingActor(fixture, "b", 6000),
        reset: reset(fixture),
        readState: async () => await readState(fixture),
        invariant: ({ outcomes, state }) => {
          expect(outcomes).toEqual(COMMITTED);
          expect(state).toEqual({
            status: INVOICE_STATUS.PAID,
            paid: TOTAL,
            payments: 2,
          });
        },
      });
      expect(results).toHaveLength(6);
    });
  }, 60_000); // timeout: six interleavings, each with its own pair of real Postgres sessions and lock waits
}
