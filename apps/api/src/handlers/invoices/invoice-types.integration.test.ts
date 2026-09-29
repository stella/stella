import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { INVOICE_STATUS, invoiceLines, invoices } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createInvoice from "@/api/handlers/invoices/create";
import createLine from "@/api/handlers/invoices/lines/create";
import updateLine from "@/api/handlers/invoices/lines/update";
import transitionInvoice from "@/api/handlers/invoices/transition";
import updateInvoice from "@/api/handlers/invoices/update";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);
let testDb: TestDatabase;
let ids: TestIds;
const seededIds: SafeId<"invoice">[] = [];
beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});
afterAll(async () => {
  if (seededIds.length > 0) {
    await testDb
      .delete(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, seededIds));
    await testDb.delete(invoices).where(inArray(invoices.id, seededIds));
  }
  await releaseRlsFixture();
});

const contextFor = <TContext>(
  _handler: (context: TContext) => unknown,
  options: {
    body: unknown;
    params: Record<string, unknown>;
    auditEvents?: AuditEvent[];
  },
): TContext => {
  const recordAuditEvent = async (
    _tx: unknown,
    events: AuditEvent | AuditEvent[],
  ) => {
    options.auditEvents?.push(...(Array.isArray(events) ? events : [events]));
  };
  return asTestRaw<TContext>({
    getActiveWorkspaceIds: async () => [ids.wsA1],
    getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
    getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
    body: options.body,
    params: options.params,
    createAuditRecorder: () => recordAuditEvent,
    memberRole: { role: "owner" },
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    recordAuditEvent,
    request: new Request(`https://example.test/workspaces/${ids.wsA1}`),
    route: "/test/invoice-types",
    safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  });
};

const seedOriginal = async (
  options: Partial<typeof invoices.$inferInsert> = {},
) => {
  const id = createSafeId<"invoice">();
  seededIds.push(id);
  await testDb.insert(invoices).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber: `ORIGINAL-${id}`,
    invoiceDate: "2026-09-29",
    currency: "USD",
    status: INVOICE_STATUS.FINALIZED,
    totalAmount: cents(1210),
    ...options,
  });
  return id;
};
const createCredit = async (
  originalInvoiceId: SafeId<"invoice">,
  auditEvents: AuditEvent[] = [],
) =>
  await createInvoice.handler(
    contextFor(createInvoice.handler, {
      params: { workspaceId: ids.wsA1 },
      body: {
        documentType: "credit_note",
        originalInvoiceId,
        invoiceNumber: `CREDIT-${createSafeId<"invoice">()}`,
        invoiceDate: "2026-09-29",
        currency: "USD",
        timeEntryIds: [],
      },
      auditEvents,
    }),
  );
const createdId = (result: unknown) => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string"
  ) {
    panic(`Expected created invoice, got ${JSON.stringify(result)}`);
  }
  const id = asTestRaw<SafeId<"invoice">>(result.id);
  seededIds.push(id);
  return id;
};
const lineBody = (unitPriceMinor: number) =>
  ({
    source: {
      type: "manual",
      description: "Credit advice",
      quantity: "1",
      unitPriceMinor,
    },
    vatRateBps: 2100,
    vatTreatment: "domestic_vat",
  }) as const;
const addLine = async (invoiceId: SafeId<"invoice">, amount: number) =>
  await createLine.handler(
    contextFor(createLine.handler, {
      params: { workspaceId: ids.wsA1, invoiceId },
      body: lineBody(amount),
    }),
  );

describe("invoice document types", () => {
  test("credit notes reject wrong-workspace, draft, void and credit-note originals", async () => {
    const valid = await seedOriginal();
    const originals = await Promise.all([
      seedOriginal({ workspaceId: ids.wsA2 }),
      seedOriginal({ status: INVOICE_STATUS.DRAFT }),
      seedOriginal({ status: INVOICE_STATUS.VOID }),
      seedOriginal({
        documentType: "credit_note",
        originalInvoiceId: valid,
        totalAmount: cents(-1210),
      }),
    ]);
    const results = await Promise.all(
      originals.map(async (original) => await createCredit(original)),
    );
    expect(
      results.map((result) => ("code" in result ? result.code : null)),
    ).toEqual([422, 409, 409, 422]);
  });

  test("credit creation records the original and stores negative line amounts and totals", async () => {
    const originalInvoiceId = await seedOriginal();
    const auditEvents: AuditEvent[] = [];
    const invoiceId = createdId(
      await createCredit(originalInvoiceId, auditEvents),
    );
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        resourceId: invoiceId,
        metadata: expect.objectContaining({ originalInvoiceId }),
      }),
    );
    expect(await addLine(invoiceId, 1000)).toMatchObject({
      totals: {
        netAmountMinor: -1000,
        vatAmountMinor: -210,
        grossAmountMinor: -1210,
      },
    });
    const rows = await testDb
      .select({
        netAmount: invoiceLines.netAmount,
        vatAmount: invoiceLines.vatAmount,
        grossAmount: invoiceLines.grossAmount,
      })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId));
    expect(rows).toEqual([
      {
        netAmount: cents(-1000),
        vatAmount: cents(-210),
        grossAmount: cents(-1210),
      },
    ]);
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: {
          documentType: true,
          originalInvoiceId: true,
          totalAmount: true,
        },
      }),
    ).toEqual({
      documentType: "credit_note",
      originalInvoiceId,
      totalAmount: cents(-1210),
    });
  });

  test("line creation and update cannot credit more than the original and roll back amounts", async () => {
    const invoiceId = createdId(await createCredit(await seedOriginal()));
    expect(await addLine(invoiceId, 1001)).toMatchObject({ code: 422 });
    expect(
      await testDb.$count(invoiceLines, eq(invoiceLines.invoiceId, invoiceId)),
    ).toBe(0);
    const created = await addLine(invoiceId, 1000);
    if (!("id" in created)) {
      panic("Expected created credit line");
    }
    expect(
      await updateLine.handler(
        contextFor(updateLine.handler, {
          params: { workspaceId: ids.wsA1, invoiceId, lineId: created.id },
          body: { unitPriceMinor: 1001 },
        }),
      ),
    ).toMatchObject({ code: 422 });
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { totalAmount: true },
      }),
    ).toEqual({ totalAmount: cents(-1210) });
  });

  test("changing a draft between invoice types preserves magnitudes and derives credit signs", async () => {
    const originalInvoiceId = await seedOriginal();
    const invoiceId = createdId(await createCredit(originalInvoiceId));
    const added = await addLine(invoiceId, 1000);
    expect(added).toMatchObject({ totals: { grossAmountMinor: -1210 } });
    for (const documentType of ["invoice", "advance", "credit_note"] as const) {
      const updated = await updateInvoice.handler(
        contextFor(updateInvoice.handler, {
          params: { workspaceId: ids.wsA1, invoiceId },
          body: {
            documentType,
            originalInvoiceId:
              documentType === "credit_note" ? originalInvoiceId : null,
          },
        }),
      );
      expect(updated).toEqual({ id: invoiceId });
      expect(
        await testDb.query.invoices.findFirst({
          where: { id: { eq: invoiceId } },
          columns: { totalAmount: true },
        }),
      ).toEqual({
        totalAmount: cents(documentType === "credit_note" ? -1210 : 1210),
      });
    }
  });

  test("document type and original remain immutable after a finalize and revert", async () => {
    const originalInvoiceId = await seedOriginal();
    const invoiceId = createdId(await createCredit(originalInvoiceId));
    const transition = async (action: "finalize" | "revert_to_draft") =>
      await transitionInvoice.handler(
        contextFor(transitionInvoice.handler, {
          params: { workspaceId: ids.wsA1, invoiceId },
          body: { action },
        }),
      );
    expect(await transition("finalize")).toEqual({ id: invoiceId });
    expect(await transition("revert_to_draft")).toEqual({ id: invoiceId });
    expect(
      await updateInvoice.handler(
        contextFor(updateInvoice.handler, {
          params: { workspaceId: ids.wsA1, invoiceId },
          body: { documentType: "invoice", originalInvoiceId: null },
        }),
      ),
    ).toMatchObject({ code: 409 });
    expect(
      await updateInvoice.handler(
        contextFor(updateInvoice.handler, {
          params: { workspaceId: ids.wsA1, invoiceId },
          body: { originalInvoiceId: await seedOriginal() },
        }),
      ),
    ).toMatchObject({ code: 409 });
  });
});
