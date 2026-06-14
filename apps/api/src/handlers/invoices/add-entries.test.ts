import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import {
  BILLING_STATUS,
  INVOICE_STATUS,
  invoices,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import addEntries from "./add-entries";

type AddEntriesCtx = Parameters<typeof addEntries.handler>[0];

const createContext = (
  body: AddEntriesCtx["body"],
  safeDb: AddEntriesCtx["safeDb"],
): AddEntriesCtx => {
  const { scopedDb } = createScopedDbMock({});
  return asTestRaw<AddEntriesCtx>({
    body,
    safeDb,
    scopedDb,
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
};

describe("addEntries currency enforcement", () => {
  test("rejects a time entry whose currency differs from the invoice", async () => {
    let call = 0;
    const safeDb: AddEntriesCtx["safeDb"] = asTestRaw<AddEntriesCtx["safeDb"]>(
      async () => {
        call += 1;
        if (call === 1) {
          return Result.ok({
            id: toSafeId<"invoice">("inv_test"),
            status: INVOICE_STATUS.DRAFT,
            currency: "USD",
          });
        }
        return Result.ok([
          {
            id: toSafeId<"timeEntry">("te_1"),
            status: BILLING_STATUS.APPROVED,
            billable: true,
            invoiceId: null,
            currency: "EUR",
          },
        ]);
      },
    );

    const result = await addEntries.handler(
      createContext(
        asTestRaw<AddEntriesCtx["body"]>({
          timeEntryIds: [toSafeId<"timeEntry">("te_1")],
        }),
        safeDb,
      ),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message: "All time entries must match the invoice currency",
      },
    });
  });

  test("returns a retryable conflict when a claim count changes", async () => {
    let auditCalls = 0;
    const lockInvoiceForUpdate = mock(async () => [
      {
        id: toSafeId<"invoice">("inv_test"),
        totalAmount: 0,
        currency: "USD",
      },
    ]);
    const { safeDb } = createScopedDbMock({
      query: {
        invoices: {
          findFirst: async () => ({
            id: toSafeId<"invoice">("inv_test"),
            status: INVOICE_STATUS.DRAFT,
            currency: "USD",
            totalAmount: 0,
          }),
        },
      },
      select: () => ({
        from: (table: unknown) => {
          if (table === invoices) {
            return {
              where: () => ({
                limit: () => ({
                  for: lockInvoiceForUpdate,
                }),
              }),
            };
          }

          return {
            where: async () => [
              {
                id: toSafeId<"timeEntry">("te_1"),
                status: BILLING_STATUS.APPROVED,
                billable: true,
                invoiceId: null,
                currency: "USD",
              },
            ],
          };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
    });

    const ctx = createContext(
      asTestRaw<AddEntriesCtx["body"]>({
        timeEntryIds: [toSafeId<"timeEntry">("te_1")],
      }),
      safeDb,
    );

    const result = await addEntries.handler(
      asTestRaw<AddEntriesCtx>({
        ...ctx,
        recordAuditEvent: async () => {
          auditCalls += 1;
        },
      }),
    );

    expect(result).toEqual({
      code: 409,
      response: {
        message: "Some entries were modified concurrently; please retry",
      },
    });
    expect(auditCalls).toBe(0);
    expect(lockInvoiceForUpdate).toHaveBeenCalledWith("update");
  });
});
