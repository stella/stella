import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  INVOICE_STATUS,
  invoices,
  invoiceSends,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import sendInvoice, {
  createSendInvoice,
} from "@/api/handlers/invoices/sends/create";
import listInvoiceSends from "@/api/handlers/invoices/sends/list";
import revokeInvoiceSend from "@/api/handlers/invoices/sends/revoke";
import { HttpStatusResponse } from "@/api/http/status";
import { createAuditRecorder } from "@/api/lib/audit-log";
import {
  createInvoiceLinkToken,
  hashInvoiceLinkToken,
} from "@/api/lib/billing/invoice-links";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { cents } from "@/api/lib/money";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

const SENDS_PER_INVOICE = 3;
// Exercise the real handler operation and SQL; only the email provider is replaced.
const measuredSendInvoice = createSendInvoice({
  admitEmail: async () =>
    await Promise.resolve(
      Result.ok({
        release: async () => await Promise.resolve(),
        commit: async () => await Promise.resolve(),
      }),
    ),
  deliver: async () => {
    await Promise.resolve();
  },
  isDeliveryConfigured: () => true,
});

/** The selected invoice retains three sends while other invoices grow the matter's history. */
export const seedInvoiceSendScaling = async (db: GatedTestDb, size: number) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Send scaling organization",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Send scaling actor",
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
    name: "Send scaling matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId });
  const invoiceIds = Array.from({ length: size }, () =>
    createSafeId<"invoice">(),
  );
  const invoiceId =
    invoiceIds.at(0) ?? panic("Send scaling requires an invoice");
  await db.insert(invoices).values(
    invoiceIds.map((id) => ({
      id,
      organizationId,
      workspaceId,
      invoiceNumber: `SEND-SCALE-${id}`,
      invoiceDate: "2020-01-01",
      currency: "USD",
      status: INVOICE_STATUS.SENT,
      sentAt: new Date("2020-01-01T12:00:00Z"),
      totalAmount: cents(1000),
    })),
  );
  const featureAccessSnapshot = enrolledTimeBillingSnapshot({
    organizationId,
    userId,
  });
  const safeDb = createMembershipSafeDb(markRlsDatabase(db), {
    organizationId,
    serverValidatedWorkspaceIds: [workspaceId],
    userId,
    featureAccessSnapshot,
  });
  const sends = invoiceIds.flatMap((id) =>
    Array.from({ length: SENDS_PER_INVOICE }, () => ({
      id: createSafeId<"invoiceSend">(),
      organizationId,
      invoiceId: id,
      sentByUserId: userId,
      recipients: ["client@example.test"],
      language: "en" as const,
      replyTo: `${userId}@example.test`,
      tokenHash: hashInvoiceLinkToken(createInvoiceLinkToken()),
      expiresAt: new Date("2020-03-01T12:00:00Z"),
      deliveryStatus: "pending" as const,
      createdAt: new Date("2020-01-01T12:00:00Z"),
    })),
  );
  const sendId = sends.at(0)?.id ?? panic("Send scaling requires a send");
  (
    await safeDb(async (tx) => {
      await tx.insert(invoiceSends).values(sends);
      await tx
        .update(invoiceSends)
        .set({ deliveryStatus: "delivered" })
        .where(eq(invoiceSends.organizationId, organizationId));
    })
  ).unwrap();
  const request = new Request("https://example.test/invoice-sends");
  return {
    invoiceId,
    sendId,
    context: {
      workspaceId,
      user: { id: userId, email: `${userId}@example.test` },
      session: { activeOrganizationId: organizationId },
      featureAccessSnapshot,
      safeDb,
      scopedDb: NO_DB,
      audit: createAuditRecorder({
        organizationId,
        workspaceId,
        userId,
        request,
        server: null,
      }),
      request,
    },
    cleanup: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type InvoiceSendScalingFixture = Awaited<
  ReturnType<typeof seedInvoiceSendScaling>
>;

/** Read the fixed history, then send and revoke once against each population. */
export const invoiceSendScalingScenarios = [
  {
    name: "invoice send list",
    type: "read",
    expectedRows: SENDS_PER_INVOICE,
    definition: listInvoiceSends,
    measure: async (fixture: InvoiceSendScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listInvoiceSends.handler(
          createTestHandlerContext<
            Parameters<typeof listInvoiceSends.handler>[0]
          >({
            ...fixture.context,
            params: {
              workspaceId: fixture.context.workspaceId,
              invoiceId: fixture.invoiceId,
            },
            route: "/v1/invoices/:workspaceId/:invoiceId/sends",
            query: {},
          }),
        );
        if (response instanceof HttpStatusResponse) {
          return panic("Send list scaling requires a successful response");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.items.length,
        };
      }),
  },
  {
    name: "invoice send create",
    type: "write",
    expectedRows: 1,
    definition: sendInvoice,
    measure: async (fixture: InvoiceSendScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await measuredSendInvoice.handler(
          createTestHandlerContext<
            Parameters<typeof measuredSendInvoice.handler>[0]
          >({
            ...fixture.context,
            params: {
              workspaceId: fixture.context.workspaceId,
              invoiceId: fixture.invoiceId,
            },
            body: { recipients: ["client@example.test"] },
            route: "/v1/invoices/:workspaceId/:invoiceId/sends",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.deliveryStatus !== "delivered"
        ) {
          return panic("Send creation scaling requires a delivered response");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "invoice send revoke",
    type: "write",
    expectedRows: 1,
    definition: revokeInvoiceSend,
    measure: async (fixture: InvoiceSendScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await revokeInvoiceSend.handler(
          createTestHandlerContext<
            Parameters<typeof revokeInvoiceSend.handler>[0]
          >({
            ...fixture.context,
            params: {
              workspaceId: fixture.context.workspaceId,
              invoiceId: fixture.invoiceId,
              sendId: fixture.sendId,
            },
            route: "/v1/invoices/:workspaceId/:invoiceId/sends/:sendId/revoke",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.id !== fixture.sendId
        ) {
          return panic(
            "Send revocation scaling requires a successful response",
          );
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
] as const;
