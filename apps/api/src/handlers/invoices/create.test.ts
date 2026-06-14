import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { BILLING_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

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
  asTestRaw<CreateInvoiceCtx>({
    body,
    safeDb,
    scopedDb,
    recordAuditEvent,
    workspaceId: toSafeId<"workspace">("ws_test"),
    memberRole: { role: "owner" },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test"),
    },
    user: { id: toSafeId<"user">("user_test") },
  });

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
      select: () => ({ from: () => ({ where: async () => entries }) }),
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
    const entries = [entry("te_1", "USD")];
    const { scopedDb } = createScopedDbMock({});

    // Production safeDb returns Result.err(DatabaseError) on a unique
    // violation; drive that directly on the insert transaction (the third
    // safeDb call) so the handler's error mapping is what is under test.
    let call = 0;
    const safeDb: CreateInvoiceCtx["safeDb"] = asTestRaw<
      CreateInvoiceCtx["safeDb"]
    >(async () => {
      call += 1;
      if (call === 1) {
        return Result.ok(0);
      }
      if (call === 2) {
        return Result.ok(entries);
      }
      return Result.err(
        new DatabaseError({
          code: PG_ERROR.UNIQUE_VIOLATION,
          message: "duplicate key",
        }),
      );
    });

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
      select: () => ({ from: () => ({ where: async () => entries }) }),
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
          "All entries must be approved, billable," +
          " and not already on an invoice",
      },
    });
  });

  test("creates a single-currency invoice and totals the entries", async () => {
    const entries = [entry("te_1", "USD"), entry("te_2", "USD")];
    const { safeDb, scopedDb } = createScopedDbMock({
      $count: async () => 0,
      select: () => ({ from: () => ({ where: async () => entries }) }),
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
            returning: async () => entries.map((e) => ({ id: e.id })),
          }),
        }),
      }),
    });

    const result = await createInvoice.handler(
      createContext({
        body: baseBody("USD", ["te_1", "te_2"]),
        safeDb,
        scopedDb,
      }),
    );

    // Success returns the raw payload (not a {code,response} envelope).
    // 2 entries * prorate(60min, 10_000 cents/h) = 2 * 10_000 = 20_000.
    expect(result).toMatchObject({
      id: "inv_1",
      totalAmount: 20_000,
      entryCount: 2,
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
      select: () => ({ from: () => ({ where: async () => entries }) }),
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
