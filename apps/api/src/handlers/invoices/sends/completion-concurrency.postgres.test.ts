import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";
import { waitForExternalState } from "@stll/property-testing/external-state";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  INVOICE_STATUS,
  invoices,
  invoiceSends,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createScopedDb,
  createTenantlessDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { createSendInvoice } from "@/api/handlers/invoices/sends/create";
import { HttpStatusResponse } from "@/api/http/status";
import { AUDIT_RESOURCE_TYPE, createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveInvoiceLink } from "@/api/lib/billing/invoice-links";
import { createSafeId } from "@/api/lib/branded-types";
import { lockInvoiceInStatus } from "@/api/lib/db/aggregate-lock";
import { cents } from "@/api/lib/money";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

const transportGate = () => ({
  reached: Promise.withResolvers<string>(),
  release: Promise.withResolvers<undefined>(),
});

const waitForMilestone = async <T>(milestone: Promise<T>, label: string) =>
  await withTimeout(async () => await milestone, { label, timeoutMs: 5000 });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "concurrent invoice send completion",
  () => {
    // timeout: observes real PostgreSQL lock waits across two completion transactions.
    test.each([
      ["a", "b"],
      ["b", "a"],
    ] as const)(
      "overlapping sends complete after %s then %s transports return, with one sent timestamp",
      async (first, second) => {
        const databaseUrl =
          process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const blocker = openClient({ max: 1 }).db;
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const workspaceId = createSafeId<"workspace">();
          const invoiceId = createSafeId<"invoice">();
          const applicationNames = {
            a: `invoice-send-a-${invoiceId}`,
            b: `invoice-send-b-${invoiceId}`,
          };
          const actors = {
            a: openClient({
              max: 1,
              connection: { application_name: applicationNames.a },
            }).db,
            b: openClient({
              max: 1,
              connection: { application_name: applicationNames.b },
            }).db,
          };
          const gates = { a: transportGate(), b: transportGate() };
          const rowLocked = Promise.withResolvers<undefined>();
          const releaseRow = Promise.withResolvers<undefined>();
          const startHolder = Promise.withResolvers<"lock" | "skip">();
          const firstSentAt = Promise.withResolvers<Date>();
          const request = new Request("https://example.test/v1/invoices/send", {
            method: "POST",
          });
          const featureAccessSnapshot = enrolledTimeBillingSnapshot({
            organizationId,
            userId,
          });
          const recorder = createAuditRecorder({
            organizationId,
            workspaceId,
            userId,
            request,
            server: null,
          });
          const audit: AuditRecorder = async (tx, event) => {
            await recorder(tx, event);
            const events = Array.isArray(event) ? event : [event];
            if (
              !events.some(
                (entry) =>
                  entry.resourceType === AUDIT_RESOURCE_TYPE.INVOICE &&
                  entry.changes?.["action"]?.new === "send",
              )
            ) {
              return;
            }
            const [invoice] = await tx
              .select({ sentAt: invoices.sentAt })
              .from(invoices)
              .where(eq(invoices.id, invoiceId));
            firstSentAt.resolve(
              invoice?.sentAt ?? panic("Send transition did not stamp sentAt"),
            );
          };
          const sendInvoice = createSendInvoice({
            admitEmail: async () => Result.ok(undefined),
            isDeliveryConfigured: () => true,
            deliver: async ({ to, link }) => {
              const gate = to === "a@example.test" ? gates.a : gates.b;
              gate.reached.resolve(new URL(link).hash.slice(1));
              await gate.release.promise;
            },
          });
          await db.insert(organization).values({
            id: organizationId,
            name: "Concurrent sends",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(user).values({
            id: userId,
            name: "Invoice sender",
            email: `${userId}@example.test`,
            emailVerified: true,
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
            name: "Concurrent send matter",
            reference: workspaceId,
          });
          await db.insert(workspaceMembers).values({ workspaceId, userId });
          await db.insert(invoices).values({
            id: invoiceId,
            organizationId,
            workspaceId,
            invoiceNumber: `CONCURRENT-${invoiceId}`,
            invoiceDate: "2026-10-01",
            currency: "EUR",
            status: INVOICE_STATUS.FINALIZED,
            finalizedAt: new Date(),
            totalAmount: cents(1000),
          });
          const invoke = async (actor: "a" | "b") => {
            const safeDb = createMembershipSafeDb(
              markRlsDatabase(actors[actor]),
              {
                organizationId,
                userId,
                serverValidatedWorkspaceIds: [workspaceId],
                featureAccessSnapshot,
              },
            );
            return await sendInvoice.handler(
              createTestHandlerContext<
                Parameters<typeof sendInvoice.handler>[0]
              >({
                workspaceId,
                user: { id: userId, email: `${userId}@example.test` },
                session: { activeOrganizationId: organizationId },
                featureAccessSnapshot,
                safeDb,
                scopedDb: NO_DB,
                audit,
                request,
                params: { workspaceId, invoiceId },
                body: { recipients: [`${actor}@example.test`] },
                route: "/v1/invoices/:workspaceId/:invoiceId/sends",
              }),
            );
          };
          const responses = {
            a: Result.tryPromise(async () => await invoke("a")),
            b: Result.tryPromise(async () => await invoke("b")),
          };
          // Both handler transactions reserve their pending send before either transport returns.
          const holdCompletion = Result.tryPromise(async () => {
            if ((await startHolder.promise) === "skip") {
              return;
            }
            const safeDb = createMembershipSafeDb(markRlsDatabase(blocker), {
              organizationId,
              userId,
              serverValidatedWorkspaceIds: [workspaceId],
              featureAccessSnapshot,
            });
            (
              await safeDb(async (tx) => {
                const locked = await lockInvoiceInStatus(tx, {
                  invoiceId,
                  workspaceId,
                  status: INVOICE_STATUS.FINALIZED,
                  matterLocks: { type: "acquire" },
                });
                expect(locked?.status).toBe(INVOICE_STATUS.FINALIZED);
                expect(locked?.sentAt).toBeNull();
                rowLocked.resolve(undefined);
                await releaseRow.promise;
              })
            ).unwrap();
          });
          try {
            const tokens = await waitForMilestone(
              Promise.all([gates.a.reached.promise, gates.b.reached.promise]),
              "both sends reach the transport",
            );
            startHolder.resolve("lock");
            await waitForMilestone(
              rowLocked.promise,
              "invoice completion lock held",
            );
            expect(
              await db
                .select({ status: invoiceSends.deliveryStatus })
                .from(invoiceSends)
                .where(eq(invoiceSends.invoiceId, invoiceId)),
            ).toEqual([{ status: "pending" }, { status: "pending" }]);
            gates[first].release.resolve(undefined);
            await waitForExternalState({
              description:
                "the first returning transport reaches the aggregate lock",
              read: async () => {
                const [waiting] = await db
                  .select({ count: sql`count(*)`.mapWith(Number) })
                  .from(sql`pg_catalog.pg_stat_activity`)
                  .where(
                    sql`application_name = ${applicationNames[first]} AND wait_event_type = 'Lock'`,
                  );
                return waiting?.count === 1;
              },
            });
            gates[second].release.resolve(undefined);
            // The old read-before-lock path reads finalized twice here. The owning
            // lock makes each completion observe status only after the preceding one commits.
            await waitForExternalState({
              description:
                "both invoice completions are waiting on the held aggregate",
              read: async () => {
                const [waiting] = await db
                  .select({ count: sql`count(*)`.mapWith(Number) })
                  .from(sql`pg_catalog.pg_stat_activity`)
                  .where(
                    sql`application_name IN (${applicationNames.a}, ${applicationNames.b}) AND wait_event_type = 'Lock'`,
                  );
                return waiting?.count === 2;
              },
            });
            releaseRow.resolve(undefined);
            (await holdCompletion).unwrap();
            const results = await Promise.all([responses.a, responses.b]);
            for (const result of results) {
              const response = result.unwrap();
              expect(response).not.toBeInstanceOf(HttpStatusResponse);
              expect(response).toMatchObject({
                deliveryStatus: "delivered",
                invoiceStatus: INVOICE_STATUS.SENT,
              });
            }
            const [stored] = await db
              .select({ status: invoices.status, sentAt: invoices.sentAt })
              .from(invoices)
              .where(eq(invoices.id, invoiceId));
            expect(stored).toEqual({
              status: INVOICE_STATUS.SENT,
              sentAt: await waitForMilestone(
                firstSentAt.promise,
                "G9 send timestamp captured",
              ),
            });
            const sends = await db
              .select({
                status: invoiceSends.deliveryStatus,
                revokedAt: invoiceSends.revokedAt,
              })
              .from(invoiceSends)
              .where(eq(invoiceSends.invoiceId, invoiceId));
            expect(sends).toEqual([
              { status: "delivered", revokedAt: null },
              { status: "delivered", revokedAt: null },
            ]);
            const transitions = await db
              .select({ id: auditLogs.id })
              .from(auditLogs)
              .where(
                and(
                  eq(auditLogs.resourceId, invoiceId),
                  sql`${auditLogs.changes}->'action'->>'new' = 'send'`,
                ),
              );
            expect(transitions).toHaveLength(1);
            const database = {
              tenantless: createTenantlessDb(markRlsDatabase(db)),
              scoped: ({ organizationId: org, userId: actor, workspaceIds }) =>
                createScopedDb(markRlsDatabase(db), workspaceIds, org, actor),
            } satisfies TokenScopedDatabase;
            for (const token of tokens) {
              expect(await resolveInvoiceLink(database, token)).toMatchObject({
                organizationId,
                invoiceId,
                workspaceIds: [workspaceId],
              });
            }
          } finally {
            startHolder.resolve("skip");
            gates.a.release.resolve(undefined);
            gates.b.release.resolve(undefined);
            releaseRow.resolve(undefined);
            await Promise.all([responses.a, responses.b, holdCompletion]);
            await db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await db.delete(user).where(eq(user.id, userId));
          }
        });
      },
      20_000,
    );
  },
);
