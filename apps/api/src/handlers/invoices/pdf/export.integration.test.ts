import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { INVOICE_LINE_SOURCE } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { user as authUser } from "@/api/db/auth-schema";
import {
  BILLING_STATUS,
  featureEnrolments,
  INVOICE_ATTACHMENT,
  INVOICE_STATUS,
  invoiceLines,
  invoicePayments,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import recordInvoicePayment from "@/api/handlers/invoices/payments/create";
import voidInvoicePayment from "@/api/handlers/invoices/payments/void";
import type exportInvoicePdf from "@/api/handlers/invoices/pdf/export";
import { createInvoicePdfExport } from "@/api/handlers/invoices/pdf/export";
import type { RenderInvoicePdfOptions } from "@/api/handlers/invoices/pdf/render-helpers";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { S3_OBJECT_WRITE_CERTAINTY } from "@/api/lib/s3";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

// Selected by the STELLA_RUN_POSTGRES_TESTS gate because the fixture exercises RLS.
let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
const invoiceId = createSafeId<"invoice">();
const settlementInvoiceIds: SafeId<"invoice">[] = [];
beforeAll(async () => {
  fixture = await getRlsFixture();

  await fixture.testDb
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [fixture.ids.userA1, fixture.ids.userB1]));
  await fixture.testDb
    .insert(featureEnrolments)
    .values([
      {
        organizationId: fixture.ids.orgA,
        userId: fixture.ids.userA1,
        featureId: "time-billing",
      },
      {
        organizationId: fixture.ids.orgB,
        userId: fixture.ids.userB1,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
  await fixture.testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: fixture.ids.orgA,
    workspaceId: fixture.ids.wsA1,
    invoiceDate: "2026-09-30",
    status: INVOICE_STATUS.DRAFT,
    currency: "CZK",
    language: "sk",
    netAmount: cents(500_000),
    vatAmount: cents(105_000),
    totalAmount: cents(605_000),
  });
  await fixture.testDb.insert(invoiceLines).values({
    organizationId: fixture.ids.orgA,
    workspaceId: fixture.ids.wsA1,
    invoiceId,
    position: 0,
    description: "Contract review",
    quantity: "2.5",
    unit: "h",
    unitPrice: cents(200_000),
    vatRateBps: 2100,
    vatTreatment: "domestic_vat",
    netAmount: cents(500_000),
    vatAmount: cents(105_000),
    grossAmount: cents(605_000),
    source: INVOICE_LINE_SOURCE.MANUAL,
  });
});
afterAll(async () => {
  if (settlementInvoiceIds.length > 0) {
    await fixture.testDb
      .delete(invoicePayments)
      .where(inArray(invoicePayments.invoiceId, settlementInvoiceIds));
    await fixture.testDb
      .delete(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, settlementInvoiceIds));
    await fixture.testDb
      .delete(invoices)
      .where(inArray(invoices.id, settlementInvoiceIds));
  }
  await fixture.testDb
    .delete(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId));
  await fixture.testDb.delete(invoices).where(eq(invoices.id, invoiceId));
  await releaseRlsFixture();
});

const context = (
  scope: "own" | "neighbour" | "other",
  auditEvents: AuditEvent[],
  targetInvoiceId = invoiceId,
) => {
  const { testDb, ids } = fixture;
  const scopes = {
    own: {
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
    },
    neighbour: {
      workspaceId: ids.wsA2,
      organizationId: ids.orgA,
      userId: ids.userA1,
    },
    other: {
      workspaceId: ids.wsB1,
      organizationId: ids.orgB,
      userId: ids.userB1,
    },
  };
  const { workspaceId, organizationId, userId } = scopes[scope];
  const recordAuditEvent = async (
    _tx: unknown,
    events: AuditEvent | AuditEvent[],
  ) => {
    auditEvents.push(...(Array.isArray(events) ? events : [events]));
  };
  return asTestRaw<Parameters<typeof exportInvoicePdf.handler>[0]>({
    getActiveWorkspaceIds: async () => [workspaceId],
    getAccessibleWorkspaces: async () => [
      { id: workspaceId, status: "active" },
    ],
    getWorkspaceAccess: async () => ({ id: workspaceId, status: "active" }),
    params: { workspaceId, invoiceId: targetInvoiceId },
    query: {},
    body: {},
    createAuditRecorder: () => recordAuditEvent,
    recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    request: new Request("https://example.test/invoice/pdf", {
      method: "POST",
      headers: { "Accept-Language": "en" },
    }),
    route: "/v1/invoices/:workspaceId/:invoiceId/pdf" satisfies ApiRoutePath,
    safeDb: createSafeDb(testDb, [workspaceId], organizationId, userId),
    scopedDb: createScopedDb(testDb, [workspaceId], organizationId, userId),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  });
};

describe("invoice document export", () => {
  test("exports payment instructions for each ledger settlement state", async () => {
    const settlementInvoiceId = createSafeId<"invoice">();
    settlementInvoiceIds.push(settlementInvoiceId);
    const { testDb, ids } = fixture;
    await testDb.insert(invoices).values({
      id: settlementInvoiceId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceNumber: `INV-SETTLEMENT-${settlementInvoiceId}`,
      invoiceDate: "2026-09-30",
      status: INVOICE_STATUS.FINALIZED,
      currency: "CZK",
      language: "cs",
      netAmount: cents(500_000),
      vatAmount: cents(105_000),
      totalAmount: cents(605_000),
    });
    await testDb.insert(invoiceLines).values({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceId: settlementInvoiceId,
      position: 0,
      description: "Settlement export line",
      quantity: "1",
      unit: "h",
      unitPrice: cents(500_000),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(500_000),
      vatAmount: cents(105_000),
      grossAmount: cents(605_000),
      source: INVOICE_LINE_SOURCE.MANUAL,
    });

    const settlements: RenderInvoicePdfOptions["settlement"][] = [];
    const writtenKeys: string[] = [];
    const handler = createInvoicePdfExport(
      async ({ key }) => {
        writtenKeys.push(key);
        return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
      },
      async ({ invoice }) => {
        settlements.push(invoice.settlement);
        return Result.ok({
          status: "rendered" as const,
          pdf: new Uint8Array([37, 80, 68, 70]),
          compileMs: 1,
          peakRssBytes: 1,
        });
      },
    );
    const exportPdf = async () =>
      await handler.handler(context("own", [], settlementInvoiceId));
    const pay = async (amount: number) =>
      recordInvoicePayment.handler(
        asTestRaw<Parameters<typeof recordInvoicePayment.handler>[0]>({
          ...context("own", [], settlementInvoiceId),
          route: "/v1/invoices/:workspaceId/:invoiceId/payments",
          body: {
            amount,
            paidOn: Temporal.Now.plainDateISO("UTC")
              .subtract({ days: 1 })
              .toString(),
            method: "bank_transfer",
            reference: null,
            note: null,
          },
        }),
      );

    await exportPdf();
    const partialPayment = await pay(200_000);
    if (!isRecord(partialPayment) || typeof partialPayment.id !== "string") {
      throw new Error("the payment ledger did not return a payment id");
    }
    await exportPdf();
    await pay(405_000);
    await exportPdf();
    await voidInvoicePayment.handler(
      asTestRaw<Parameters<typeof voidInvoicePayment.handler>[0]>({
        ...context("own", [], settlementInvoiceId),
        route: "/v1/invoices/:workspaceId/:invoiceId/payments/:paymentId/void",
        params: {
          ...context("own", [], settlementInvoiceId).params,
          paymentId: partialPayment.id,
        },
      }),
    );
    await exportPdf();

    expect(settlements).toEqual([
      { status: "due", amountMinor: cents(605_000) },
      { status: "due", amountMinor: cents(405_000) },
      { status: "settled" },
      { status: "due", amountMinor: cents(200_000) },
    ]);
    expect(writtenKeys).toHaveLength(4);
    expect(new Set(writtenKeys).size).toBe(4);
  });

  test("states payment from the printed total and the invoice's settled rule", async () => {
    const { testDb, ids } = fixture;
    const legacyInvoiceId = createSafeId<"invoice">();
    const zeroInvoiceId = createSafeId<"invoice">();
    settlementInvoiceIds.push(legacyInvoiceId, zeroInvoiceId);
    // A legacy invoice (no stored net amount) whose stored total does not
    // count its line: the document prints the line, so the payment is due.
    await testDb.insert(invoices).values([
      {
        id: legacyInvoiceId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        invoiceNumber: `INV-LEGACY-${legacyInvoiceId}`,
        invoiceDate: "2026-09-30",
        status: INVOICE_STATUS.FINALIZED,
        currency: "CZK",
        language: "cs",
        netAmount: null,
        vatAmount: null,
        totalAmount: cents(0),
      },
      {
        id: zeroInvoiceId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        invoiceNumber: `INV-ZERO-${zeroInvoiceId}`,
        invoiceDate: "2026-09-30",
        status: INVOICE_STATUS.FINALIZED,
        currency: "CZK",
        language: "cs",
        netAmount: cents(0),
        vatAmount: cents(0),
        totalAmount: cents(0),
      },
    ]);
    await testDb.insert(invoiceLines).values({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceId: legacyInvoiceId,
      position: 0,
      description: "Legacy export line",
      quantity: "1",
      unit: "h",
      unitPrice: cents(100_000),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(100_000),
      vatAmount: cents(21_000),
      grossAmount: cents(121_000),
      source: INVOICE_LINE_SOURCE.MANUAL,
    });
    const settlements: RenderInvoicePdfOptions["settlement"][] = [];
    const handler = createInvoicePdfExport(
      async () => S3_OBJECT_WRITE_CERTAINTY.CONFIRMED,
      async ({ invoice }) => {
        settlements.push(invoice.settlement);
        return Result.ok({
          status: "rendered" as const,
          pdf: new Uint8Array([37, 80, 68, 70]),
          compileMs: 1,
          peakRssBytes: 1,
        });
      },
    );
    await handler.handler(context("own", [], legacyInvoiceId));
    await handler.handler(context("own", [], zeroInvoiceId));

    expect(settlements).toEqual([
      { status: "due", amountMinor: cents(121_000) },
      { status: "not_payable" },
    ]);
  });

  test("returns an expiring scoped artifact and records its download", async () => {
    const events: AuditEvent[] = [];
    const writes: Parameters<
      NonNullable<Parameters<typeof createInvoicePdfExport>[0]>
    >[0][] = [];
    const handler = createInvoicePdfExport(async (object) => {
      writes.push(object);
      return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
    });
    const response = await handler.handler(context("own", events));
    expect(response).toMatchObject({ fileName: "invoice-draft.pdf" });
    expect("downloadUrl" in response).toBe(true);
    if (!("downloadUrl" in response)) {
      return;
    }
    const url = new URL(response.downloadUrl);
    expect(url.pathname).toContain(
      `exports/${fixture.ids.orgA}/${fixture.ids.wsA1}/invoices/${invoiceId}/`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-disposition")).toContain(
      "invoice-draft.pdf",
    );
    expect(url.searchParams.get("response-cache-control")).toContain(
      "no-store",
    );
    expect(Date.parse(response.expiresAt) - Date.now()).toBeGreaterThan(
      290_000,
    );
    expect(writes).toHaveLength(1);
    const written = writes.at(0);
    expect(written?.contentType).toBe("application/pdf");
    expect(written?.key).toContain(
      `exports/${fixture.ids.orgA}/${fixture.ids.wsA1}/`,
    );
    if (!(written?.data instanceof Uint8Array)) {
      throw new Error("the export stored no PDF bytes");
    }
    expect(new TextDecoder().decode(written.data)).toStartWith("%PDF-");
    const text = (await PDF.load(written.data))
      .extractText()
      .map((page) => page.text)
      .join("\n");
    expect(text).toContain("Contract review");
    // Slovak column headers, with the figures under them.
    expect(text).toContain("MNOŽSTVO");
    expect(text).toContain("JEDNOTKOVÁ CENA");
    expect(text).toContain("2,5 h");
    expect(events).toHaveLength(1);
    expect(events.at(0)).toMatchObject({
      action: "download",
      resourceType: "invoice",
      resourceId: invoiceId,
      workspaceId: fixture.ids.wsA1,
    });
  });
  test("exports a legacy invoice whose attached entry has no stored line", async () => {
    const legacyInvoiceId = createSafeId<"invoice">();
    const entryId = createSafeId<"timeEntry">();
    const { testDb, ids } = fixture;
    // A legacy invoice stores no net amount: its document adds a line for
    // each attached entry that has none after its stored lines.
    await testDb.insert(invoices).values({
      id: legacyInvoiceId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceDate: "2026-09-30",
      status: INVOICE_STATUS.DRAFT,
      currency: "CZK",
      language: "en",
      netAmount: null,
    });
    await testDb.insert(invoiceLines).values({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceId: legacyInvoiceId,
      position: 0,
      description: "Stored advice line",
      quantity: "1",
      unit: "h",
      unitPrice: cents(100_000),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(100_000),
      vatAmount: cents(21_000),
      grossAmount: cents(121_000),
      source: INVOICE_LINE_SOURCE.MANUAL,
    });
    await testDb.insert(timeEntries).values({
      id: entryId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      workItemId: ids.entityA1,
      dateWorked: "2026-09-28",
      timezoneId: "UTC",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: cents(50_000),
      currency: "CZK",
      narrative: "Attached hearing preparation",
      noCharge: false,
      status: BILLING_STATUS.APPROVED,
      invoiceId: legacyInvoiceId,
      invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
    });
    try {
      const writes: Uint8Array[] = [];
      const handler = createInvoicePdfExport(async (object) => {
        if (object.data instanceof Uint8Array) {
          writes.push(object.data);
        }
        return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
      });
      const response = await handler.handler(
        context("own", [], legacyInvoiceId),
      );
      expect("downloadUrl" in response).toBe(true);
      const written = writes.at(0);
      if (written === undefined) {
        throw new Error("the export stored no PDF bytes");
      }
      const text = (await PDF.load(written))
        .extractText()
        .map((page) => page.text)
        .join("\n");
      expect(text).toContain("Stored advice line");
      expect(text).toContain("Attached hearing preparation");
    } finally {
      await testDb.delete(timeEntries).where(eq(timeEntries.id, entryId));
      await testDb
        .delete(invoiceLines)
        .where(eq(invoiceLines.invoiceId, legacyInvoiceId));
      await testDb.delete(invoices).where(eq(invoices.id, legacyInvoiceId));
    }
  });

  test("renders English stored on the invoice despite a Slovak request", async () => {
    await fixture.testDb
      .update(invoices)
      .set({ language: "en" })
      .where(eq(invoices.id, invoiceId));
    const stored: Uint8Array[] = [];
    const handler = createInvoicePdfExport(async (object) => {
      if (typeof object.data === "string") {
        throw new TypeError("invoice export must store PDF bytes");
      }
      stored.push(object.data);
      return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
    });
    const requestContext = {
      ...context("own", []),
      request: new Request("https://example.test/invoice/pdf", {
        method: "POST",
        headers: { "Accept-Language": "sk" },
      }),
    };
    await handler.handler(requestContext);
    const pdf = stored.at(0);
    if (pdf === undefined) {
      throw new Error("the export stored no PDF bytes");
    }
    const text = (await PDF.load(pdf))
      .extractText()
      .map((page) => page.text)
      .join("\n");
    // English column headers, with the figures under them.
    expect(text).toContain("QUANTITY");
    expect(text).toContain("UNIT PRICE");
    expect(text).toContain("2.5 h");
  });
  test.each(["timeout", "crashed", "memory"] as const)(
    "maps renderer %s failures to a retryable service response",
    async (reason) => {
      let writes = 0;
      const handler = createInvoicePdfExport(
        async () => {
          writes += 1;
          return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
        },
        async () =>
          Result.ok({
            status: "rejected" as const,
            reason,
            diagnostics: ["internal renderer detail"],
          }),
      );

      const response = await handler.handler(context("own", []));

      expect(response).toMatchObject({
        code: 503,
        response: {
          message: "The invoice PDF renderer is temporarily unavailable.",
          hint: "Try exporting the invoice again later.",
          retryable: true,
        },
      });
      expect(JSON.stringify(response)).not.toContain(
        "internal renderer detail",
      );
      expect(writes).toBe(0);
    },
  );

  test("refuses delivery without a download audit when storage fails", async () => {
    const events: AuditEvent[] = [];
    const handler = createInvoicePdfExport(async () => {
      throw new HandlerError({
        status: 502,
        code: "internal_error",
        message: "Storage unavailable",
      });
    });
    const response = await handler.handler(context("own", events));
    expect(response).toMatchObject({ code: 502 });
    expect(response).not.toHaveProperty("downloadUrl");
    expect(events).toHaveLength(0);
  });
  test.each(["neighbour", "other"] as const)(
    "returns no document or audit event for the %s scope",
    async (scope) => {
      const events: AuditEvent[] = [];
      let writes = 0;
      const handler = createInvoicePdfExport(async () => {
        writes += 1;
        return S3_OBJECT_WRITE_CERTAINTY.CONFIRMED;
      });
      const response = await handler.handler(context(scope, events));
      expect(writes).toBe(0);
      expect(response).toMatchObject({ code: 404 });
      expect(events).toHaveLength(0);
    },
  );
});
