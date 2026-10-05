import { describe, expect, test } from "bun:test";

import { invoices, timeEntries, INVOICE_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import {
  createSelectQueryMock,
  createScopedDbMock,
} from "@/api/tests/scoped-db-mock";

import updateInvoice from "./update";

type UpdateInvoiceCtx = Parameters<typeof updateInvoice.handler>[0];

const createContext = ({
  body,
  safeDb,
}: {
  body: UpdateInvoiceCtx["body"];
  safeDb: UpdateInvoiceCtx["safeDb"];
}): UpdateInvoiceCtx =>
  withTimeBillingEnrolment(
    asTestRaw<UpdateInvoiceCtx>({
      body,
      request: new Request(
        "https://example.test/v1/invoices/ws_test/inv_test",
        {
          method: "PATCH",
        },
      ),
      route: "/v1/invoices/:workspaceId/:invoiceId",
      safeDb,
      params: {
        workspaceId: toSafeId<"workspace">("ws_test"),
        invoiceId: toSafeId<"invoice">("inv_test"),
      },
      workspaceId: toSafeId<"workspace">("ws_test"),
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: toSafeId<"organization">("org_test") },
      user: { id: toSafeId<"user">("user_test") },
      recordAuditEvent: async () => {},
    }),
  );

describe("updateInvoice currency integrity", () => {
  test("rejects a currency change while entries are attached", async () => {
    const { safeDb } = createScopedDbMock({
      select: () => ({
        from: (table: unknown) => {
          if (table === invoices) {
            return createSelectQueryMock([
              {
                id: toSafeId<"invoice">("inv_test"),
                status: INVOICE_STATUS.DRAFT,
                documentType: "invoice",
                originalInvoiceId: null,
                finalizedAt: null,
                billingMode: "hourly",
                flatFeeAmount: null,
                currency: "USD",
                dueDate: null,
                invoiceDate: "2026-06-14",
                invoiceNumber: "INV-001",
                notes: null,
                reference: null,
              },
            ]).from();
          }
          return createSelectQueryMock(
            table === timeEntries
              ? [{ id: toSafeId<"timeEntry">("te_1") }]
              : [],
          ).from();
        },
      }),
    });

    const result = await updateInvoice.handler(
      createContext({
        body: { currency: "EUR" },
        safeDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message: "Invoice currency cannot change while entries are attached",
      },
    });
  });
});
