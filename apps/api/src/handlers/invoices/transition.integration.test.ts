import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import {
  BILLING_STATUS,
  expenses,
  featureEnrolments,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  numberSeries,
  sellerProfiles,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { VatRateUnavailableError } from "@/api/lib/billing/vat-exchange-rates";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import deleteInvoice from "./delete";
import transitionInvoice, { createTransitionInvoice } from "./transition";
import updateInvoice from "./update";

setDefaultTimeout(120_000);

type TransitionCtx = Parameters<typeof transitionInvoice.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

const seededInvoiceIds: SafeId<"invoice">[] = [];
const seededTimeEntryIds: SafeId<"timeEntry">[] = [];
const seededSeriesIds: SafeId<"numberSeries">[] = [];
const seededExpenseIds: SafeId<"expense">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1]));
  await testDb
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userA1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  try {
    if (seededSeriesIds.length > 0) {
      await testDb
        .delete(numberSeries)
        .where(inArray(numberSeries.id, seededSeriesIds));
    }
    if (seededTimeEntryIds.length > 0) {
      await testDb
        .delete(timeEntries)
        .where(inArray(timeEntries.id, seededTimeEntryIds));
    }
    if (seededExpenseIds.length > 0) {
      await testDb
        .delete(expenses)
        .where(inArray(expenses.id, seededExpenseIds));
    }
    if (seededInvoiceIds.length > 0) {
      await testDb
        .delete(invoices)
        .where(inArray(invoices.id, seededInvoiceIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("invoice transition integration", () => {
  test("finalizes a draft invoice and rejects a repeated finalize", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });

    const firstResult = await runTransition(invoiceId, "finalize");
    const secondResult = await runTransition(invoiceId, "finalize");

    expect(firstResult).toEqual({ id: invoiceId });
    expect(secondResult).toEqual({
      code: 409,
      response: { message: "Cannot finalize invoice from its current status" },
    });
    expect(await readInvoiceStatus(invoiceId)).toBe(INVOICE_STATUS.FINALIZED);
  });

  test("finalizes a reverse charge only with the buyer's VAT ID", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    await testDb.insert(invoiceLines).values({
      id: createSafeId<"invoiceLine">(),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceId,
      position: 0,
      description: "Legal advice",
      quantity: "1.0000",
      unit: "h",
      unitPrice: cents(10_000),
      vatRateBps: 0,
      vatTreatment: "reverse_charge",
      netAmount: cents(10_000),
      vatAmount: cents(0),
      grossAmount: cents(10_000),
      source: "manual",
    });

    expect(await runTransition(invoiceId, "finalize")).toMatchObject({
      code: 400,
      response: { message: "Reverse charge requires a buyer VAT ID" },
    });
    await testDb
      .update(invoices)
      .set({ buyerVatId: "DE123456789" })
      .where(eq(invoices.id, invoiceId));
    expect(await runTransition(invoiceId, "finalize")).toEqual({
      id: invoiceId,
    });
    expect(await readInvoiceStatus(invoiceId)).toBe(INVOICE_STATUS.FINALIZED);
  });

  test("keeps a foreign-currency Slovak invoice in draft when the official rate is unavailable", async () => {
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId: ids.orgA,
      legalName: "Kancelária Dunaj",
      vatId: "SK1234567890",
      vatPayer: true,
      country: "SK",
      defaultCurrency: "USD",
    });
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    await testDb
      .update(invoices)
      .set({ sellerProfileId })
      .where(eq(invoices.id, invoiceId));
    await testDb.insert(invoiceLines).values({
      id: createSafeId<"invoiceLine">(),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceId,
      position: 0,
      description: "Právna konzultácia",
      quantity: "1.0000",
      unit: "h",
      unitPrice: cents(10_000),
      vatRateBps: 2300,
      vatTreatment: "domestic_vat",
      netAmount: cents(10_000),
      vatAmount: cents(2300),
      grossAmount: cents(12_300),
      source: "manual",
    });
    await testDb
      .update(invoices)
      .set({ vatAmount: cents(2300) })
      .where(eq(invoices.id, invoiceId));

    const failingHandler = createTransitionInvoice({
      rateSource: async () =>
        Result.err(
          new VatRateUnavailableError({ message: "sensitive upstream detail" }),
        ),
    });
    expect(
      await failingHandler.handler(
        asTestRaw<Parameters<typeof failingHandler.handler>[0]>(
          createContext({ invoiceId, action: "finalize", auditEvents: [] }),
        ),
      ),
    ).toEqual({
      code: 503,
      response: {
        code: "upstream_unavailable",
        message: "The official VAT exchange-rate service is unavailable",
        hint: "Retry finalizing later; no changes were made to the invoice.",
      },
    });
    expect(await readInvoiceStatus(invoiceId)).toBe(INVOICE_STATUS.DRAFT);
    await testDb.delete(invoices).where(eq(invoices.id, invoiceId));
    await testDb
      .delete(sellerProfiles)
      .where(eq(sellerProfiles.id, sellerProfileId));
  });

  test("refinalizing legacy totals reads VAT without rewriting the issued document", async () => {
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId: ids.orgA,
      legalName: "Legacy invoice seller",
      vatId: "SK1234567890",
      vatPayer: true,
      country: "SK",
      defaultCurrency: "USD",
    });
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    try {
      await testDb
        .update(invoices)
        .set({
          sellerProfileId,
          finalizedAt: new Date("2025-01-02T00:00:00Z"),
          netAmount: null,
          vatAmount: null,
          totalAmount: cents(12_300),
        })
        .where(eq(invoices.id, invoiceId));
      await testDb.insert(invoiceLines).values({
        id: createSafeId<"invoiceLine">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        invoiceId,
        position: 0,
        description: "Issued legal services",
        quantity: "1.0000",
        unit: "h",
        unitPrice: cents(10_000),
        vatRateBps: 2300,
        vatTreatment: "domestic_vat",
        netAmount: cents(10_000),
        vatAmount: cents(2300),
        grossAmount: cents(12_300),
        source: "manual",
      });
      const readDocument = async () =>
        await testDb.query.invoices.findFirst({
          where: { id: { eq: invoiceId } },
          with: { lines: true },
        });
      const beforeRefusal = await readDocument();
      const auditEvents: AuditEvent[] = [];
      expect(await runTransition(invoiceId, "finalize", auditEvents)).toEqual({
        code: 409,
        response: {
          message:
            "This issued invoice states VAT in USD without the official exchange rate to EUR",
          hint: "Its issued content cannot change: issue a credit note for it and a corrected invoice.",
        },
      });
      expect(await readDocument()).toEqual(beforeRefusal);
      expect(auditEvents).toEqual([]);

      await testDb
        .update(invoices)
        .set({ currency: "EUR" })
        .where(eq(invoices.id, invoiceId));
      const beforeFinalize = await readDocument();
      if (beforeFinalize === undefined) {
        panic("The issued invoice must exist before re-finalizing");
      }
      expect(beforeFinalize).toMatchObject({
        netAmount: null,
        vatAmount: null,
        totalAmount: cents(12_300),
      });
      expect(beforeFinalize.lines).toHaveLength(1);
      expect(beforeFinalize.lines.at(0)?.vatAmount).toBe(cents(2300));
      expect(await runTransition(invoiceId, "finalize")).toEqual({
        id: invoiceId,
      });
      expect(await readDocument()).toEqual({
        ...beforeFinalize,
        status: INVOICE_STATUS.FINALIZED,
        updatedAt: expect.any(Date),
      });
    } finally {
      await testDb.delete(invoices).where(eq(invoices.id, invoiceId));
      await testDb
        .delete(sellerProfiles)
        .where(eq(sellerProfiles.id, sellerProfileId));
    }
  });

  test("keys a Polish rate to the issue date of an invoice issued before the supply (art. 31a ust. 2)", async () => {
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId: ids.orgA,
      legalName: "PL seller",
      vatId: "PL5260001246",
      vatPayer: true,
      country: "PL",
      defaultCurrency: "EUR",
    });
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    await testDb
      .update(invoices)
      .set({
        sellerProfileId,
        currency: "EUR",
        invoiceDate: "2026-06-10",
        taxableSupplyDate: "2026-06-22",
      })
      .where(eq(invoices.id, invoiceId));
    await seedVatLine(invoiceId, 10_000);
    const requested: string[] = [];
    const handler = createTransitionInvoice({
      rateSource: async ({ referenceDate }) => {
        requested.push(referenceDate);
        return Result.ok({
          rate: "4.250000000000",
          source: "NBP",
          effectiveDate: "2026-06-09",
          sourceReference: "110/A/NBP/2026",
        });
      },
    });
    const context = asTestRaw<Parameters<typeof handler.handler>[0]>(
      createContext({ invoiceId, action: "finalize", auditEvents: [] }),
    );
    expect(await handler.handler(context)).toEqual({ id: invoiceId });
    expect(requested).toEqual(["2026-06-10"]);
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { vatExchangeRateTaxPoint: true },
      }),
    ).toEqual({ vatExchangeRateTaxPoint: "2026-06-22" });
    await testDb.delete(invoices).where(eq(invoices.id, invoiceId));
    await testDb
      .delete(sellerProfiles)
      .where(eq(sellerProfiles.id, sellerProfileId));
  });

  test("lines whose VAT offsets to a zero total still resolve and store the rate", async () => {
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId: ids.orgA,
      legalName: "CZ seller",
      vatId: "CZ12345678",
      vatPayer: true,
      country: "CZ",
      defaultCurrency: "EUR",
    });
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    await testDb
      .update(invoices)
      .set({ sellerProfileId, currency: "EUR", vatAmount: cents(0) })
      .where(eq(invoices.id, invoiceId));
    await seedVatLine(invoiceId, 10_000);
    await seedVatLine(invoiceId, -10_000);
    let calls = 0;
    const handler = createTransitionInvoice({
      rateSource: async () => {
        calls += 1;
        return Result.ok({
          rate: "24.330000000000",
          source: "CNB",
          effectiveDate: "2026-06-22",
          sourceReference: null,
        });
      },
    });
    const context = asTestRaw<Parameters<typeof handler.handler>[0]>(
      createContext({ invoiceId, action: "finalize", auditEvents: [] }),
    );
    expect(await handler.handler(context)).toEqual({ id: invoiceId });
    expect(calls).toBe(1);
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { vatExchangeRate: true },
      }),
    ).toEqual({ vatExchangeRate: "24.330000000000" });
    await testDb.delete(invoices).where(eq(invoices.id, invoiceId));
    await testDb
      .delete(sellerProfiles)
      .where(eq(sellerProfiles.id, sellerProfileId));
  });

  test("finalizes a zero-VAT foreign-currency invoice without requesting a rate", async () => {
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId: ids.orgA,
      legalName: "Reverse charge seller",
      vatId: "CZ12345678",
      vatPayer: true,
      country: "CZ",
      defaultCurrency: "EUR",
    });
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    await testDb
      .update(invoices)
      .set({ sellerProfileId, currency: "EUR", vatAmount: cents(0) })
      .where(eq(invoices.id, invoiceId));
    let calls = 0;
    const handler = createTransitionInvoice({
      rateSource: async () => {
        calls += 1;
        throw new Error("rate source must not be called");
      },
    });
    expect(
      await handler.handler(
        asTestRaw<Parameters<typeof handler.handler>[0]>(
          createContext({ invoiceId, action: "finalize", auditEvents: [] }),
        ),
      ),
    ).toEqual({ id: invoiceId });
    expect(calls).toBe(0);
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { vatExchangeRate: true },
      }),
    ).toEqual({ vatExchangeRate: null });
    await testDb.delete(invoices).where(eq(invoices.id, invoiceId));
    await testDb
      .delete(sellerProfiles)
      .where(eq(sellerProfiles.id, sellerProfileId));
  });

  test.each([
    { country: "CZ", currency: "EUR", source: "CNB", reference: null },
    { country: "SK", currency: "USD", source: "ECB", reference: null },
    {
      country: "PL",
      currency: "EUR",
      source: "NBP",
      reference: "001/A/NBP/2026",
    },
  ] as const)(
    "stores the official $source rate for a $country VAT invoice",
    async (sample) => {
      const sellerProfileId = createSafeId<"sellerProfile">();
      await testDb.insert(sellerProfiles).values({
        id: sellerProfileId,
        organizationId: ids.orgA,
        legalName: `${sample.country} seller`,
        vatId: `${sample.country}12345678`,
        vatPayer: true,
        country: sample.country,
        defaultCurrency: sample.currency,
      });
      const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
      await testDb
        .update(invoices)
        .set({
          sellerProfileId,
          currency: sample.currency,
          // A stale stored total: the rate decision must read the lines.
          vatAmount: cents(0),
          taxableSupplyDate: "2026-06-22",
        })
        .where(eq(invoices.id, invoiceId));
      await seedVatLine(invoiceId, 10_000);
      const handler = createTransitionInvoice({
        rateSource: async () =>
          Result.ok({
            rate: "24.750000000000",
            source: sample.source,
            effectiveDate: "2026-06-19",
            sourceReference: sample.reference,
          }),
      });
      const context = asTestRaw<Parameters<typeof handler.handler>[0]>(
        createContext({ invoiceId, action: "finalize", auditEvents: [] }),
      );
      expect(await handler.handler(context)).toEqual({ id: invoiceId });
      expect(
        await testDb.query.invoices.findFirst({
          where: { id: { eq: invoiceId } },
          columns: {
            vatExchangeRate: true,
            vatExchangeRateSource: true,
            vatExchangeRateDate: true,
            vatExchangeRateReference: true,
            vatExchangeRateTaxPoint: true,
          },
        }),
      ).toEqual({
        vatExchangeRate: "24.750000000000",
        vatExchangeRateSource: sample.source,
        vatExchangeRateDate: "2026-06-19",
        vatExchangeRateReference: sample.reference,
        vatExchangeRateTaxPoint: "2026-06-22",
      });
      if (sample.country === "CZ") {
        expect(await runTransition(invoiceId, "revert_to_draft")).toEqual({
          id: invoiceId,
        });
        // An issued invoice keeps its content: reverting keeps the rate, and
        // finalizing again restores the same document without a new rate.
        const readRate = async () =>
          await testDb.query.invoices.findFirst({
            where: { id: { eq: invoiceId } },
            columns: { vatExchangeRate: true, vatExchangeRateSource: true },
          });
        expect(await readRate()).toEqual({
          vatExchangeRate: "24.750000000000",
          vatExchangeRateSource: sample.source,
        });
        expect(await handler.handler(context)).toEqual({ id: invoiceId });
        expect(await readRate()).toEqual({
          vatExchangeRate: "24.750000000000",
          vatExchangeRateSource: sample.source,
        });
      }
      await testDb.delete(invoices).where(eq(invoices.id, invoiceId));
      await testDb
        .delete(sellerProfiles)
        .where(eq(sellerProfiles.id, sellerProfileId));
    },
  );

  test("refuses finalization when a rate input changes during resolution", async () => {
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId: ids.orgA,
      legalName: "Concurrent seller",
      vatId: "CZ12345678",
      vatPayer: true,
      country: "CZ",
      defaultCurrency: "EUR",
    });
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    await testDb
      .update(invoices)
      .set({ sellerProfileId, currency: "EUR", vatAmount: cents(2100) })
      .where(eq(invoices.id, invoiceId));
    await seedVatLine(invoiceId, 10_000);
    const handler = createTransitionInvoice({
      rateSource: async () => {
        await testDb
          .update(invoices)
          .set({ invoiceDate: "2026-06-24" })
          .where(eq(invoices.id, invoiceId));
        return Result.ok({
          rate: "24.75",
          source: "CNB",
          effectiveDate: "2026-06-23",
          sourceReference: null,
        });
      },
    });
    expect(
      await handler.handler(
        asTestRaw<Parameters<typeof handler.handler>[0]>(
          createContext({ invoiceId, action: "finalize", auditEvents: [] }),
        ),
      ),
    ).toMatchObject({ code: 409 });
    expect(await readInvoiceStatus(invoiceId)).toBe(INVOICE_STATUS.DRAFT);
    await testDb.delete(invoices).where(eq(invoices.id, invoiceId));
    await testDb
      .delete(sellerProfiles)
      .where(eq(sellerProfiles.id, sellerProfileId));
  });

  test("refuses a foreign-currency credit note before requesting a rate", async () => {
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId: ids.orgA,
      legalName: "Credit seller",
      vatId: "CZ12345678",
      vatPayer: true,
      country: "CZ",
      defaultCurrency: "EUR",
    });
    const originalInvoiceId = await seedInvoice({
      status: INVOICE_STATUS.FINALIZED,
    });
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
    await testDb
      .update(invoices)
      .set({
        documentType: "credit_note",
        originalInvoiceId,
        sellerProfileId,
        currency: "EUR",
        vatAmount: cents(2100),
      })
      .where(eq(invoices.id, invoiceId));
    await seedVatLine(invoiceId, -10_000);
    let calls = 0;
    const handler = createTransitionInvoice({
      rateSource: async () => {
        calls += 1;
        return Result.ok({
          rate: "24.75",
          source: "CNB",
          effectiveDate: "2026-06-23",
          sourceReference: null,
        });
      },
    });
    expect(
      await handler.handler(
        asTestRaw<Parameters<typeof handler.handler>[0]>(
          createContext({ invoiceId, action: "finalize", auditEvents: [] }),
        ),
      ),
    ).toMatchObject({ code: 409 });
    expect(calls).toBe(0);
    await testDb
      .delete(invoices)
      .where(inArray(invoices.id, [invoiceId, originalInvoiceId]));
    await testDb
      .delete(sellerProfiles)
      .where(eq(sellerProfiles.id, sellerProfileId));
  });

  test.each(["exempt", "not_vat_payer"] as const)(
    "refuses a Polish %s line without its exemption basis",
    async (vatTreatment) => {
      const sellerProfileId = createSafeId<"sellerProfile">();
      await testDb.insert(sellerProfiles).values({
        id: sellerProfileId,
        organizationId: ids.orgA,
        legalName: "Kancelaria Wisła",
        vatId: "PL5260001246",
        vatPayer: vatTreatment !== "not_vat_payer",
        country: "PL",
        defaultCurrency: "PLN",
      });
      const invoiceId = await seedInvoice({ status: INVOICE_STATUS.DRAFT });
      await testDb
        .update(invoices)
        .set({ sellerProfileId, currency: "PLN" })
        .where(eq(invoices.id, invoiceId));
      await testDb.insert(invoiceLines).values({
        id: createSafeId<"invoiceLine">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        invoiceId,
        position: 0,
        description: "Porada prawna",
        quantity: "1.0000",
        unit: "h",
        unitPrice: cents(10_000),
        vatRateBps: 0,
        vatTreatment,
        netAmount: cents(10_000),
        vatAmount: cents(0),
        grossAmount: cents(10_000),
        source: "manual",
      });

      expect(await runTransition(invoiceId, "finalize")).toEqual({
        code: 400,
        response: {
          message: `Polish ${vatTreatment} invoice lines require an exemption basis`,
          hint: "Add the statutory exemption reason to every exempt or non-VAT-payer line, then finalize again.",
        },
      });
      await testDb.delete(invoices).where(eq(invoices.id, invoiceId));
      await testDb
        .delete(sellerProfiles)
        .where(eq(sellerProfiles.id, sellerProfileId));
    },
  );

  test("allocates consecutive default-series numbers and keeps the first through revert and refinalize", async () => {
    const seriesId = createSafeId<"numberSeries">();
    seededSeriesIds.push(seriesId);
    await testDb.insert(numberSeries).values({
      id: seriesId,
      organizationId: ids.orgA,
      documentType: "invoice",
      name: "Default invoices",
      pattern: "AUTO-{YYYY}-{SEQ}",
      padding: 3,
      isDefault: true,
    });
    const first = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: null,
    });
    const second = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: null,
    });
    expect(await runTransition(first, "finalize")).toEqual({ id: first });
    expect(await runTransition(second, "finalize")).toEqual({ id: second });
    const readNumber = async (invoiceId: SafeId<"invoice">) =>
      (
        await testDb.query.invoices.findFirst({
          where: { id: { eq: invoiceId } },
          columns: { invoiceNumber: true },
        })
      )?.invoiceNumber;
    expect(await readNumber(first)).toBe("AUTO-2026-001");
    expect(await readNumber(second)).toBe("AUTO-2026-002");
    expect(await runTransition(first, "revert_to_draft")).toEqual({
      id: first,
    });
    expect(await readNumber(first)).toBe("AUTO-2026-001");
    await assertAssignedNumber(first, "AUTO-2026-001");
    expect(await runTransition(first, "finalize")).toEqual({ id: first });
    expect(await readNumber(first)).toBe("AUTO-2026-001");
    expect(await runTransition(second, "void")).toEqual({ id: second });
    expect(await readNumber(second)).toBe("AUTO-2026-002");
    const third = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: null,
    });
    expect(await runTransition(third, "finalize")).toEqual({ id: third });
    expect(await readNumber(third)).toBe("AUTO-2026-003");
    await testDb.delete(numberSeries).where(eq(numberSeries.id, seriesId));
  });

  test("preserves a manual number through edits after reverting to draft", async () => {
    const invoiceId = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: "REVERTED-001",
    });
    expect(await runTransition(invoiceId, "finalize")).toEqual({
      id: invoiceId,
    });
    expect(await runTransition(invoiceId, "revert_to_draft")).toEqual({
      id: invoiceId,
    });
    await assertAssignedNumber(invoiceId, "REVERTED-001");
    expect(await runTransition(invoiceId, "finalize")).toEqual({
      id: invoiceId,
    });
    const invoice = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
    });
    expect(invoice?.invoiceNumber).toBe("REVERTED-001");
  });

  test("a draft that was never finalized can still change, clear and lose its number", async () => {
    const invoiceId = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: "DRAFT-001",
    });
    const context = createContext({
      invoiceId,
      action: "finalize",
      auditEvents: [],
    });
    for (const invoiceNumber of ["DRAFT-002", null, "DRAFT-003"]) {
      expect(
        await updateInvoice.handler({ ...context, body: { invoiceNumber } }),
      ).toEqual({ id: invoiceId });
      const row = await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { invoiceNumber: true },
      });
      expect(row?.invoiceNumber).toBe(invoiceNumber);
    }
    expect(
      await deleteInvoice.handler(
        asTestRaw<Parameters<typeof deleteInvoice.handler>[0]>(context),
      ),
    ).toEqual({ deleted: true });
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
      }),
    ).toBeUndefined();
  });

  test("requires a default series for an unnumbered invoice but preserves a manual number", async () => {
    const unnumbered = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: null,
    });
    expect(await runTransition(unnumbered, "finalize")).toMatchObject({
      code: 409,
      response: { hint: expect.any(String) },
    });
    expect(await readInvoiceStatus(unnumbered)).toBe(INVOICE_STATUS.DRAFT);
    const manual = await seedInvoice({
      status: INVOICE_STATUS.DRAFT,
      invoiceNumber: "MANUAL-001",
    });
    expect(await runTransition(manual, "finalize")).toEqual({ id: manual });
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: manual } },
        columns: { invoiceNumber: true },
      }),
    ).toEqual({ invoiceNumber: "MANUAL-001" });
  });

  test("marking an invoice paid records the time and voiding clears it", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.SENT });
    expect(await runTransition(invoiceId, "mark_paid")).toEqual({
      id: invoiceId,
    });
    const paid = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
      columns: { paidAt: true },
    });
    expect(paid?.paidAt).toBeInstanceOf(Date);
    expect(await runTransition(invoiceId, "void")).toEqual({ id: invoiceId });
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { paidAt: true },
      }),
    ).toEqual({ paidAt: null });
  });

  test("voiding a paid invoice detaches billed entries and expenses", async () => {
    const invoiceId = await seedInvoice({ status: INVOICE_STATUS.PAID });
    const timeEntryId = createSafeId<"timeEntry">();
    const expenseId = createSafeId<"expense">();
    seededTimeEntryIds.push(timeEntryId);
    seededExpenseIds.push(expenseId);

    await testDb.insert(timeEntries).values({
      id: timeEntryId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      workItemId: ids.entityA1,
      dateWorked: "2026-06-23",
      timezoneId: "UTC",
      durationMinutes: 30,
      billedMinutes: 30,
      rateAtEntry: cents(200),
      currency: "USD",
      narrative: "Transition integration time entry",
      status: BILLING_STATUS.BILLED,
      invoiceId,
    });
    await testDb.insert(expenses).values({
      id: expenseId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      matterId: ids.entityA1,
      dateIncurred: "2026-06-23",
      amount: cents(100),
      currency: "USD",
      category: "filing_fee",
      description: "Transition integration expense",
      status: BILLING_STATUS.BILLED,
      invoiceId,
    });

    const auditEvents: AuditEvent[] = [];
    const result = await runTransition(invoiceId, "void", auditEvents);

    expect(result).toEqual({ id: invoiceId });
    expect(await readInvoiceStatus(invoiceId)).toBe(INVOICE_STATUS.VOID);
    expect(
      await testDb.query.timeEntries.findFirst({
        where: { id: { eq: timeEntryId } },
        columns: { invoiceId: true, status: true },
      }),
    ).toEqual({ invoiceId: null, status: BILLING_STATUS.APPROVED });
    expect(
      await testDb.query.expenses.findFirst({
        where: { id: { eq: expenseId } },
        columns: { invoiceId: true, status: true },
      }),
    ).toEqual({ invoiceId: null, status: BILLING_STATUS.APPROVED });
    expect(auditEvents.map((event) => event.resourceId).toSorted()).toEqual(
      [invoiceId, timeEntryId, expenseId].toSorted(),
    );
  });
});

const seedInvoice = async ({
  status,
  invoiceNumber,
}: {
  status: (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];
  invoiceNumber?: string | null;
}) => {
  const invoiceId = createSafeId<"invoice">();
  seededInvoiceIds.push(invoiceId);
  await testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber:
      invoiceNumber === undefined ? `INV-TEST-${invoiceId}` : invoiceNumber,
    invoiceDate: "2026-06-23",
    currency: "USD",
    status,
  });
  return invoiceId;
};

/** One standard-rate line whose VAT the finalize recomputes from. */
const seedVatLine = async (
  invoiceId: SafeId<"invoice">,
  netAmountMinor: number,
) => {
  const vatAmountMinor = netAmountMinor * 0.21;
  await testDb.insert(invoiceLines).values({
    id: createSafeId<"invoiceLine">(),
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceId,
    position: 0,
    description: "Legal advice",
    quantity: "1.0000",
    unit: "h",
    unitPrice: cents(Math.abs(netAmountMinor)),
    vatRateBps: 2100,
    vatTreatment: "domestic_vat",
    netAmount: cents(netAmountMinor),
    vatAmount: cents(vatAmountMinor),
    grossAmount: cents(netAmountMinor + vatAmountMinor),
    source: "manual",
  });
};

const runTransition = async (
  invoiceId: SafeId<"invoice">,
  action: TransitionCtx["body"]["action"],
  auditEvents: AuditEvent[] = [],
) =>
  await transitionInvoice.handler(
    createContext({
      action,
      auditEvents,
      invoiceId,
    }),
  );

const createContext = ({
  action,
  auditEvents,
  invoiceId,
}: {
  action: TransitionCtx["body"]["action"];
  auditEvents: AuditEvent[];
  invoiceId: SafeId<"invoice">;
}): TransitionCtx => {
  const scopedDb = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const recordAuditEvent: TransitionCtx["recordAuditEvent"] = async (
    _tx,
    events,
  ) => {
    if (Array.isArray(events)) {
      auditEvents.push(...events);
      return;
    }
    auditEvents.push(events);
  };

  return asTestRaw<TransitionCtx>({
    getActiveWorkspaceIds: async () => [ids.wsA1],
    getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
    getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
    body: { action },
    createAuditRecorder: () => recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
    params: { workspaceId: ids.wsA1, invoiceId },
    promptCachingEnabled: false,
    recordAuditEvent,
    request: new Request(`https://example.test/workspaces/${ids.wsA1}`),
    route:
      "/v1/invoices/:workspaceId/:invoiceId/transition" satisfies ApiRoutePath,
    safeDb,
    scopedDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  });
};

const readInvoiceStatus = async (invoiceId: SafeId<"invoice">) => {
  const row = await testDb.query.invoices.findFirst({
    where: { id: { eq: invoiceId } },
    columns: { status: true },
  });
  return row?.status ?? null;
};

const assertAssignedNumber = async (
  invoiceId: SafeId<"invoice">,
  assignedNumber: string,
) => {
  const context = createContext({
    invoiceId,
    action: "finalize",
    auditEvents: [],
  });
  for (const invoiceNumber of [null, `${assignedNumber}-CHANGED`]) {
    const result = await updateInvoice.handler({
      ...context,
      body: { invoiceNumber },
    });
    expect(result).toMatchObject({ code: 409 });
    const invoice = await testDb.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
    });
    expect(invoice?.invoiceNumber).toBe(assignedNumber);
  }
  expect(
    await updateInvoice.handler({
      ...context,
      body: { invoiceNumber: assignedNumber },
    }),
  ).toEqual({ id: invoiceId });
  expect(
    await updateInvoice.handler({
      ...context,
      body: { notes: "Updated notes" },
    }),
  ).toEqual({ id: invoiceId });
};
