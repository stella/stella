import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  INVOICE_PAYMENT_ORIGIN,
  INVOICE_STATUS,
  invoicePayments,
  invoices,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import recordInvoicePayment from "@/api/handlers/invoices/payments/create";
import listInvoicePayments from "@/api/handlers/invoices/payments/list";
import voidInvoicePayment from "@/api/handlers/invoices/payments/void";
import { HttpStatusResponse } from "@/api/http/status";
import { createAuditRecorder } from "@/api/lib/audit-log";
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

const PAYMENTS_PER_INVOICE = 10;
const TOTAL = 1000;
const PAID_ON = "2020-01-02";

/**
 * The requested invoice always has ten payments. Other invoices grow the
 * matter's payment population from 100 to 2000 without enlarging the response.
 */
export const seedInvoicePaymentScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Payment scaling organization",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Payment scaling actor",
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
    name: "Payment scaling matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId });
  const invoiceIds = Array.from({ length: size }, () =>
    createSafeId<"invoice">(),
  );
  const invoiceId =
    invoiceIds.at(0) ?? panic("Payment scaling requires an invoice");
  await db.insert(invoices).values(
    invoiceIds.map((id) => ({
      id,
      organizationId,
      workspaceId,
      invoiceNumber: `PAY-SCALE-${id}`,
      invoiceDate: "2020-01-01",
      currency: "USD",
      status: INVOICE_STATUS.SENT,
      sentAt: new Date("2020-01-01T12:00:00Z"),
      totalAmount: cents(TOTAL),
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
  const payments = invoiceIds.flatMap((id) =>
    Array.from({ length: PAYMENTS_PER_INVOICE }, () => ({
      id: createSafeId<"invoicePayment">(),
      organizationId,
      invoiceId: id,
      amount: cents(1),
      paidOn: PAID_ON,
      method: "bank_transfer" as const,
      origin: INVOICE_PAYMENT_ORIGIN.RECORDED,
      recordedBy: userId,
    })),
  );
  const paymentId =
    payments.at(0)?.id ?? panic("Payment scaling requires a payment");
  (
    await safeDb(async (tx) => {
      await tx.insert(invoicePayments).values(payments);
    })
  ).unwrap();
  const request = new Request("https://example.test/invoice-payments");
  return {
    invoiceId,
    paymentId,
    context: {
      workspaceId,
      user: { id: userId },
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

type InvoicePaymentScalingFixture = Awaited<
  ReturnType<typeof seedInvoicePaymentScaling>
>;

/** List first, then settle the invoice and reverse one of its payments. */
export const invoicePaymentScalingScenarios = [
  {
    name: "invoice payment list",
    type: "read",
    expectedRows: PAYMENTS_PER_INVOICE,
    definition: listInvoicePayments,
    measure: async (fixture: InvoicePaymentScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listInvoicePayments.handler(
          createTestHandlerContext<
            Parameters<typeof listInvoicePayments.handler>[0]
          >({
            ...fixture.context,
            params: {
              workspaceId: fixture.context.workspaceId,
              invoiceId: fixture.invoiceId,
            },
            route: "/v1/invoices/:workspaceId/:invoiceId/payments",
          }),
        );
        if (response instanceof HttpStatusResponse) {
          return panic("Payment list scaling requires a successful response");
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
    name: "invoice payment record",
    type: "write",
    expectedRows: 1,
    definition: recordInvoicePayment,
    measure: async (fixture: InvoicePaymentScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await recordInvoicePayment.handler(
          createTestHandlerContext<
            Parameters<typeof recordInvoicePayment.handler>[0]
          >({
            ...fixture.context,
            params: {
              workspaceId: fixture.context.workspaceId,
              invoiceId: fixture.invoiceId,
            },
            body: {
              amount: TOTAL - PAYMENTS_PER_INVOICE,
              paidOn: PAID_ON,
              method: "bank_transfer",
              reference: null,
              note: null,
            },
            route: "/v1/invoices/:workspaceId/:invoiceId/payments",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.amount !== TOTAL - PAYMENTS_PER_INVOICE
        ) {
          return panic(
            "Payment recording scaling requires a successful response",
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
  {
    name: "invoice payment void",
    type: "write",
    expectedRows: 1,
    definition: voidInvoicePayment,
    measure: async (fixture: InvoicePaymentScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await voidInvoicePayment.handler(
          createTestHandlerContext<
            Parameters<typeof voidInvoicePayment.handler>[0]
          >({
            ...fixture.context,
            params: {
              workspaceId: fixture.context.workspaceId,
              invoiceId: fixture.invoiceId,
              paymentId: fixture.paymentId,
            },
            route:
              "/v1/invoices/:workspaceId/:invoiceId/payments/:paymentId/void",
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.id !== fixture.paymentId ||
          response.voidedAt === null
        ) {
          return panic("Payment void scaling requires a successful response");
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
