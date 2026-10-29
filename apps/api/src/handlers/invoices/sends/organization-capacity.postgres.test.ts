import { describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  INVOICE_STATUS,
  invoices,
  invoiceSends,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { prepareInvoiceSend } from "@/api/handlers/invoices/sends/create";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import {
  createInvoiceLinkToken,
  hashInvoiceLinkToken,
  INVOICE_SENDS_PER_INVOICE_PER_DAY,
  INVOICE_SENDS_PER_ORGANIZATION_PER_DAY,
} from "@/api/lib/billing/invoice-links";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type CapacitySeedOptions = {
  db: GatedTestDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: Record<"a" | "b", SafeId<"workspace">>;
  invoiceIds: Record<"a" | "b", SafeId<"invoice">>;
};

const seedCapacity = async ({
  db,
  organizationId,
  userId,
  workspaceIds,
  invoiceIds,
}: CapacitySeedOptions) => {
  const existingSendCount = INVOICE_SENDS_PER_ORGANIZATION_PER_DAY - 1;
  const historyInvoiceIds = Array.from(
    {
      length: Math.ceil(existingSendCount / INVOICE_SENDS_PER_INVOICE_PER_DAY),
    },
    () => createSafeId<"invoice">(),
  );
  await db.insert(organization).values({
    id: organizationId,
    name: "Send capacity organization",
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
  await db.insert(workspaces).values(
    Object.values(workspaceIds).map((id) => ({
      id,
      organizationId,
      name: "Send capacity matter",
      reference: id,
    })),
  );
  await db.insert(workspaceMembers).values(
    Object.values(workspaceIds).map((workspaceId) => ({
      workspaceId,
      userId,
    })),
  );
  await db.insert(invoices).values(
    [
      ...historyInvoiceIds.map((id) => ({
        id,
        workspaceId: workspaceIds.a,
      })),
      { id: invoiceIds.a, workspaceId: workspaceIds.a },
      { id: invoiceIds.b, workspaceId: workspaceIds.b },
    ].map(({ id, workspaceId }) => ({
      id,
      organizationId,
      workspaceId,
      invoiceNumber: `SEND-${id}`,
      invoiceDate: "2026-10-01",
      currency: "EUR",
      status: INVOICE_STATUS.SENT,
      sentAt: new Date(),
      totalAmount: cents(1000),
    })),
  );
  const safeDb = createMembershipSafeDb(markRlsDatabase(db), {
    organizationId,
    serverValidatedWorkspaceIds: Object.values(workspaceIds),
    userId,
    featureAccessSnapshot: enrolledTimeBillingSnapshot({
      organizationId,
      userId,
    }),
  });
  (
    await safeDb(
      async (tx) =>
        await tx.insert(invoiceSends).values(
          historyInvoiceIds.flatMap((invoiceId, invoiceIndex) =>
            Array.from(
              {
                length: Math.min(
                  INVOICE_SENDS_PER_INVOICE_PER_DAY,
                  existingSendCount -
                    invoiceIndex * INVOICE_SENDS_PER_INVOICE_PER_DAY,
                ),
              },
              () => ({
                id: createSafeId<"invoiceSend">(),
                organizationId,
                invoiceId,
                recipients: ["client@example.test"],
                language: "en" as const,
                replyTo: `${userId}@example.test`,
                tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()),
                expiresAt: new Date(Date.now() + 86_400_000),
                deliveryStatus: "delivered" as const,
              }),
            ),
          ),
        ),
    )
  ).unwrap();
};

if (!databaseUrl || !runPostgres) {
  describe.skip("invoice send organization capacity (postgres)", () => {
    test("requires the Postgres test gate and database URL", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("two matters competing for the final daily send slot admit exactly one reservation in every interleaving", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const actors = {
        a: openClient({ max: 1 }).db,
        b: openClient({ max: 1 }).db,
      };
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceIds = {
        a: createSafeId<"workspace">(),
        b: createSafeId<"workspace">(),
      };
      const invoiceIds = {
        a: createSafeId<"invoice">(),
        b: createSafeId<"invoice">(),
      };
      const recordAuditEvent = createBackgroundAuditRecorder({
        organizationId,
        workspaceId: null,
        userId,
        execution: {
          performer: { type: "user", id: userId },
          trigger: { type: "system", source: "invoice_send_capacity_test" },
        },
      });
      const refusals: HandlerError[] = [];
      let accepted = 0;
      try {
        await db.insert(user).values({
          id: userId,
          name: "Send capacity member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        const actor = (name: "a" | "b") => {
          const safeDb = createMembershipSafeDb(markRlsDatabase(actors[name]), {
            organizationId,
            serverValidatedWorkspaceIds: [workspaceIds[name]],
            userId,
            featureAccessSnapshot: enrolledTimeBillingSnapshot({
              organizationId,
              userId,
            }),
          });
          return {
            steps: [
              {
                name: "reserve",
                run: async (tx: Transaction) => {
                  const reserved = await prepareInvoiceSend(tx, {
                    invoiceId: invoiceIds[name],
                    workspaceId: workspaceIds[name],
                    organizationId,
                    userId,
                    userEmail: `${userId}@example.test`,
                    recipients: ["client@example.test"],
                    message: null,
                    tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()),
                    now: new Date(),
                    recordAuditEvent,
                  });
                  if (reserved.isErr()) {
                    refusals.push(reserved.error);
                  } else {
                    accepted += 1;
                  }
                },
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
        const results = await withInterleaving({
          databaseUrl,
          a: actor("a"),
          b: actor("b"),
          reset: async () => {
            accepted = 0;
            refusals.splice(0);
            await db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await seedCapacity({
              db,
              organizationId,
              userId,
              workspaceIds,
              invoiceIds,
            });
          },
          readState: async () =>
            (
              await db
                .select({ sends: count() })
                .from(invoiceSends)
                .where(eq(invoiceSends.organizationId, organizationId))
            ).at(0),
          invariant: ({ outcomes, state }) => {
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
            expect(accepted).toBe(1);
            expect(refusals).toHaveLength(1);
            expect(refusals.at(0)).toMatchObject({
              status: 429,
              code: "invoice_send_limit",
            });
            expect(state).toEqual({
              sends: INVOICE_SENDS_PER_ORGANIZATION_PER_DAY,
            });
          },
        });
        expect(results).toHaveLength(6);
        expect(results.some(({ blocked }) => blocked.length > 0)).toBe(true);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  }, 60_000); // timeout: six real Postgres transaction schedules, each allowing a blocking capacity-lock wait
}
