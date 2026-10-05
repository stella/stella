import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { BILLING_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { PG_ERROR } from "@/api/lib/pg-error";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import createInvoice from "./create";

type CreateInvoiceCtx = Parameters<typeof createInvoice.handler>[0];

const entry = (id: string, currency: string) => ({
  id: toSafeId<"timeEntry">(id),
  billedMinutes: 60,
  rateAtEntry: 10_000,
  status: BILLING_STATUS.APPROVED,
  billable: true,
  currency,
  invoiceId: null,
});

const createContext = ({
  body,
  safeDb,
  scopedDb,
  recordAuditEvent = async () => {},
}: {
  body: CreateInvoiceCtx["body"];
  safeDb: CreateInvoiceCtx["safeDb"];
  scopedDb: CreateInvoiceCtx["scopedDb"];
  recordAuditEvent?: CreateInvoiceCtx["recordAuditEvent"];
}): CreateInvoiceCtx =>
  withTimeBillingEnrolment(
    asTestRaw<CreateInvoiceCtx>({
      body,
      request: new Request("https://example.test/v1/invoices/ws_test", {
        method: "PUT",
      }),
      route: "/v1/invoices/:workspaceId",
      safeDb,
      scopedDb,
      recordAuditEvent,
      workspaceId: toSafeId<"workspace">("ws_test"),
      memberRole: sessionMemberRole("owner"),
      session: {
        activeOrganizationId: toSafeId<"organization">("org_test"),
      },
      user: { id: toSafeId<"user">("user_test") },
    }),
  );

const baseBody = (currency: string, ids: string[]): CreateInvoiceCtx["body"] =>
  asTestRaw<CreateInvoiceCtx["body"]>({
    invoiceNumber: "INV-001",
    invoiceDate: "2026-06-14",
    currency,
    timeEntryIds: ids.map((id) => toSafeId<"timeEntry">(id)),
  });

describe("createInvoice", () => {
  test("rejects entries whose currency differs from the invoice currency", async () => {
    const entries = [entry("te_1", "USD"), entry("te_2", "EUR")];
    const { safeDb, scopedDb } = createScopedDbMock({
      $count: async () => 0,
      select: (fields?: object) =>
        createSelectQueryMock(fields && "status" in fields ? entries : []),
    });

    const result = await createInvoice.handler(
      createContext({
        body: baseBody("USD", ["te_1", "te_2"]),
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message: "All time entries must match the invoice currency",
      },
    });
  });

  test("returns 409 when the invoice number already exists", async () => {
    const { scopedDb } = createScopedDbMock({});
    // The guarded creation now validates and inserts in one transaction.
    const safeDb = asTestRaw<CreateInvoiceCtx["safeDb"]>(async () =>
      Result.err(
        new DatabaseError({
          code: PG_ERROR.UNIQUE_VIOLATION,
          message: "duplicate key",
        }),
      ),
    );

    const result = await createInvoice.handler(
      createContext({
        body: baseBody("USD", ["te_1"]),
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 409,
      response: { message: "An invoice with this number already exists" },
    });
  });

  test("rejects entries that are already attached to another invoice", async () => {
    const entries = [
      {
        ...entry("te_1", "USD"),
        invoiceId: toSafeId<"invoice">("inv_existing"),
      },
    ];
    const { safeDb, scopedDb } = createScopedDbMock({
      $count: async () => 0,
      select: (fields?: object) =>
        createSelectQueryMock(fields && "status" in fields ? entries : []),
    });

    const result = await createInvoice.handler(
      createContext({
        body: baseBody("USD", ["te_1"]),
        safeDb,
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message:
          "All entries must be approved, not already on an invoice, and billable for hourly billing",
      },
    });
  });

  test("returns a retryable conflict when the claim count changes", async () => {
    const entries = [entry("te_1", "USD"), entry("te_2", "USD")];
    const firstEntry = entries.at(0);
    if (!firstEntry) {
      throw new Error("Expected fixture entry");
    }
    let auditCalls = 0;
    const { safeDb, scopedDb } = createScopedDbMock({
      $count: async () => 0,
      select: (fields?: object) =>
        createSelectQueryMock(fields && "status" in fields ? entries : []),
      insert: () => ({
        values: () => ({
          returning: async () => [
            { id: toSafeId<"invoice">("inv_1"), invoiceNumber: "INV-001" },
          ],
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: firstEntry.id }],
          }),
        }),
      }),
    });

    const result = await createInvoice.handler(
      createContext({
        body: baseBody("USD", ["te_1", "te_2"]),
        safeDb,
        scopedDb,
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
  });
});
