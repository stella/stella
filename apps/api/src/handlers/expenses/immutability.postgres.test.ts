import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  BILLING_STATUS,
  entities,
  expenses,
  invoices,
  workspaceMembers,
  workspaces,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import addEntries from "../invoices/entries/add";
import deleteExpense from "./delete";
import updateExpense from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("expense immutability (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("expense immutability (postgres)", () => {
    for (const operation of ["edit", "delete"] as const) {
      test(`${operation} waits for attachment and preserves the invoice amount`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const setup = openClient();
          const attachment = openClient();
          const mutation = openClient();
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const workspaceId = createSafeId<"workspace">();
          const matterId = createSafeId<"entity">();
          const expenseId = createSafeId<"expense">();
          const invoiceId = createSafeId<"invoice">();
          const claimed = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          let seeded = false;
          let attaching: ReturnType<typeof addEntries.handler> | undefined;
          let mutating:
            | ReturnType<typeof updateExpense.handler>
            | ReturnType<typeof deleteExpense.handler>
            | undefined;
          try {
            await setup.db.insert(user).values({
              id: userId,
              name: "Billing",
              email: `${userId}@billing.test`,
              emailVerified: true,
            });
            seeded = true;
            await setup.db.insert(organization).values({
              id: organizationId,
              name: "Billing",
              slug: organizationId,
              createdAt: new Date(),
            });
            await setup.db.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId,
              userId,
              role: "owner",
              createdAt: new Date(),
            });
            await setup.db.insert(featureEnrolments).values({
              organizationId,
              userId,
              featureId: "time-billing",
            });
            await setup.db.insert(workspaces).values({
              id: workspaceId,
              organizationId,
              name: "Billing",
              reference: workspaceId,
            });
            await setup.db.insert(workspaceMembers).values({
              id: createSafeId<"workspaceMember">(),
              workspaceId,
              userId,
            });
            await setup.db.insert(entities).values({
              id: matterId,
              workspaceId,
              name: "Work item",
              kind: "document",
            });
            await setup.db.insert(expenses).values({
              id: expenseId,
              organizationId,
              workspaceId,
              matterId,
              dateIncurred: "2026-10-01",
              amount: cents(1000),
              currency: "USD",
              category: "filing_fee",
              description: "Filing",
              status: BILLING_STATUS.APPROVED,
            });
            await setup.db.insert(invoices).values({
              id: invoiceId,
              organizationId,
              workspaceId,
              invoiceDate: "2026-10-01",
              currency: "USD",
            });
            const common = {
              workspaceId,
              user: { id: userId },
              session: { activeOrganizationId: organizationId },
              memberRole: sessionMemberRole("owner"),
              request: new Request("https://example.test/billing"),
              route: "/test/billing",
              recordAuditEvent: async () => {},
            };
            attaching = addEntries.handler(
              asTestRaw<Parameters<typeof addEntries.handler>[0]>({
                ...common,
                params: { workspaceId, invoiceId },
                body: { expenseIds: [expenseId] },
                safeDb: createSafeDb(
                  markRlsDatabase(attachment.db),
                  [workspaceId],
                  organizationId,
                  userId,
                ),
                recordAuditEvent: async () => {
                  // Invoice lines are inserted only after the expense claim.
                  claimed.resolve(undefined);
                  await release.promise;
                },
              }),
            );
            // A failure before the audit barrier must surface rather than hang.
            await Promise.race([
              claimed.promise,
              attaching.then(() => {
                throw new Error("Attachment finished before the claim barrier");
              }),
            ]);
            const [session] = await mutation.sql<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            if (!session) {
              throw new Error("Mutation session is missing");
            }
            const safeDb = createSafeDb(
              markRlsDatabase(mutation.db),
              [workspaceId],
              organizationId,
              userId,
            );
            mutating =
              operation === "edit"
                ? updateExpense.handler(
                    asTestRaw<Parameters<typeof updateExpense.handler>[0]>({
                      ...common,
                      safeDb,
                      body: { id: expenseId, amount: 2000 },
                    }),
                  )
                : deleteExpense.handler(
                    asTestRaw<Parameters<typeof deleteExpense.handler>[0]>({
                      ...common,
                      safeDb,
                      body: { id: expenseId },
                    }),
                  );
            let blocked = false;
            for (let attempt = 0; attempt < 200 && !blocked; attempt += 1) {
              const [row] = await setup.sql<
                { blocked: boolean }[]
              >`SELECT cardinality(pg_blocking_pids(${session.pid})) > 0 AS blocked`;
              blocked = row?.blocked === true;
              if (!blocked) {
                await Bun.sleep(10);
              }
            }
            expect(blocked).toBe(true);
            release.resolve(undefined);
            expect(await attaching).toEqual({ totalAmount: cents(1000) });
            expect(await mutating).toMatchObject({ code: 400 });
            const stored = await setup.db.query.expenses.findFirst({
              where: { id: { eq: expenseId } },
            });
            const invoice = await setup.db.query.invoices.findFirst({
              where: { id: { eq: invoiceId } },
            });
            expect(stored).toMatchObject({
              status: BILLING_STATUS.BILLED,
              amount: 1000,
              invoiceId,
            });
            expect(invoice?.totalAmount).toBe(stored?.amount);
          } finally {
            release.resolve(undefined);
            try {
              await Promise.all([attaching, mutating]);
            } finally {
              if (seeded) {
                await setup.db
                  .delete(invoices)
                  .where(eq(invoices.id, invoiceId));
                await setup.db
                  .delete(expenses)
                  .where(eq(expenses.id, expenseId));
                await setup.db
                  .delete(workspaces)
                  .where(eq(workspaces.id, workspaceId));
                await setup.db
                  .delete(organization)
                  .where(eq(organization.id, organizationId));
                await setup.db.delete(user).where(eq(user.id, userId));
              }
            }
          }
        });
      }, 30_000);
    }
  });
}
