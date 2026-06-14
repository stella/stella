import { describe, expect, test } from "bun:test";

import { INVOICE_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import updateInvoice from "./update";

type UpdateInvoiceCtx = Parameters<typeof updateInvoice.handler>[0];

const createContext = ({
  body,
  safeDb,
}: {
  body: UpdateInvoiceCtx["body"];
  safeDb: UpdateInvoiceCtx["safeDb"];
}): UpdateInvoiceCtx =>
  asTestRaw<UpdateInvoiceCtx>({
    body,
    safeDb,
    params: {
      workspaceId: toSafeId<"workspace">("ws_test"),
      invoiceId: toSafeId<"invoice">("inv_test"),
    },
    workspaceId: toSafeId<"workspace">("ws_test"),
    memberRole: { role: "owner" },
    session: { activeOrganizationId: toSafeId<"organization">("org_test") },
    user: { id: toSafeId<"user">("user_test") },
    recordAuditEvent: async () => {},
  });

describe("updateInvoice currency integrity", () => {
  test("rejects a currency change while entries are attached", async () => {
    let selectCall = 0;
    const { safeDb } = createScopedDbMock({
      select: () => {
        selectCall += 1;
        if (selectCall === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: () => ({
                  for: async () => [
                    {
                      id: toSafeId<"invoice">("inv_test"),
                      status: INVOICE_STATUS.DRAFT,
                      currency: "USD",
                      dueDate: null,
                      invoiceDate: "2026-06-14",
                      invoiceNumber: "INV-001",
                      notes: null,
                      reference: null,
                    },
                  ],
                }),
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [{ id: toSafeId<"timeEntry">("te_1") }],
            }),
          }),
        };
      },
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
