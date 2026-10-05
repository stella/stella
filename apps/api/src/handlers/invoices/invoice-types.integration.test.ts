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

import { user as authUser } from "@/api/db/auth-schema";
import {
  BILLING_STATUS,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createInvoice from "@/api/handlers/invoices/create";
import deleteInvoice from "@/api/handlers/invoices/delete";
import addEntries from "@/api/handlers/invoices/entries/add";
import getInvoice from "@/api/handlers/invoices/get";
import createLine from "@/api/handlers/invoices/lines/create";
import updateLine from "@/api/handlers/invoices/lines/update";
import listInvoices from "@/api/handlers/invoices/list";
import transitionInvoice from "@/api/handlers/invoices/transition";
import updateInvoice from "@/api/handlers/invoices/update";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditEvent } from "@/api/lib/audit-log";
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

setDefaultTimeout(120_000);
let testDb: TestDatabase;
let ids: TestIds;
const seededEntries: SafeId<"timeEntry">[] = [];
const seededIds: SafeId<"invoice">[] = [];
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
  if (seededIds.length > 0) {
    await testDb
      .delete(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, seededIds));
    await testDb.delete(invoices).where(inArray(invoices.id, seededIds));
  }
  if (seededEntries.length > 0) {
    await testDb
      .delete(timeEntries)
      .where(inArray(timeEntries.id, seededEntries));
  }
  await releaseRlsFixture();
});

const contextFor = <TContext>(
  _handler: (context: TContext) => unknown,
  options: {
    body: unknown;
    params: Record<string, unknown>;
    auditEvents?: AuditEvent[];
    query?: Record<string, unknown>;
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
    query: options.query ?? {},
    params: options.params,
    createAuditRecorder: () => recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
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

const changeStatus = async (
  invoiceId: SafeId<"invoice">,
  action: "finalize" | "void" | "revert_to_draft",
) =>
  await transitionInvoice.handler(
    contextFor(transitionInvoice.handler, {
      params: { workspaceId: ids.wsA1, invoiceId },
      body: { action },
    }),
  );
const seedEntry = async () => {
  const id = createSafeId<"timeEntry">();
  seededEntries.push(id);
  await testDb.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    workItemId: ids.entityA1,
    dateWorked: "2026-09-29",
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(100),
    currency: "USD",
    narrative: "Work",
    status: BILLING_STATUS.APPROVED,
  });
  return id;
};

describe("invoice document types", () => {
  test("unnumbered drafts keep null through detail, list, and metadata edits", async () => {
    const invoiceId = createdId(
      await createInvoice.handler(
        contextFor(createInvoice.handler, {
          params: { workspaceId: ids.wsA1 },
          body: {
            invoiceDate: "2026-09-29",
            currency: "USD",
            timeEntryIds: [],
          },
        }),
      ),
    );
    const params = { workspaceId: ids.wsA1, invoiceId };
    expect(
      await getInvoice.handler(
        contextFor(getInvoice.handler, { params, body: {} }),
      ),
    ).toMatchObject({ id: invoiceId, invoiceNumber: null });
    const listed = await listInvoices.handler(
      contextFor(listInvoices.handler, {
        params: { workspaceId: ids.wsA1 },
        body: {},
        query: { limit: 100 },
      }),
    );
    if (!("items" in listed)) {
      panic("Expected invoice list");
    }
    expect(listed.items).toContainEqual(
      expect.objectContaining({ id: invoiceId, invoiceNumber: null }),
    );
    expect(
      await updateInvoice.handler(
        contextFor(updateInvoice.handler, {
          params,
          body: { invoiceNumber: null, notes: "Draft notes" },
        }),
      ),
    ).toEqual({ id: invoiceId });
    expect(
      await getInvoice.handler(
        contextFor(getInvoice.handler, { params, body: {} }),
      ),
    ).toMatchObject({
      id: invoiceId,
      invoiceNumber: null,
      notes: "Draft notes",
    });
  });

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
  test("credit notes refuse entry attachments and type conversion without consuming unbilled work", async () => {
    const originalInvoiceId = await seedOriginal();
    const timeEntryId = await seedEntry();
    expect(
      await createInvoice.handler(
        contextFor(createInvoice.handler, {
          params: { workspaceId: ids.wsA1 },
          body: {
            documentType: "credit_note",
            originalInvoiceId,
            invoiceDate: "2026-09-29",
            currency: "USD",
            timeEntryIds: [timeEntryId],
          },
        }),
      ),
    ).toMatchObject({ code: 422 });
    const invoiceId = createdId(await createCredit(originalInvoiceId));
    expect(
      await addEntries.handler(
        contextFor(addEntries.handler, {
          params: { workspaceId: ids.wsA1, invoiceId },
          body: { timeEntryIds: [timeEntryId] },
        }),
      ),
    ).toMatchObject({ code: 422 });
    for (const source of [
      { type: "time_entry", timeEntryId },
      { type: "expense", expenseId: createSafeId<"expense">() },
    ] as const) {
      expect(
        await createLine.handler(
          contextFor(createLine.handler, {
            params: { workspaceId: ids.wsA1, invoiceId },
            body: { source, vatRateBps: 0, vatTreatment: "domestic_vat" },
          }),
        ),
      ).toMatchObject({ code: 422 });
    }
    expect(
      await testDb.query.timeEntries.findFirst({
        where: { id: { eq: timeEntryId } },
        columns: { status: true, invoiceId: true },
      }),
    ).toEqual({ status: BILLING_STATUS.APPROVED, invoiceId: null });
    const draftId = createdId(
      await createInvoice.handler(
        contextFor(createInvoice.handler, {
          params: { workspaceId: ids.wsA1 },
          body: {
            invoiceDate: "2026-09-29",
            currency: "USD",
            timeEntryIds: [timeEntryId],
          },
        }),
      ),
    );
    expect(
      await updateInvoice.handler(
        contextFor(updateInvoice.handler, {
          params: { workspaceId: ids.wsA1, invoiceId: draftId },
          body: { documentType: "credit_note", originalInvoiceId },
        }),
      ),
    ).toMatchObject({ code: 422 });
    expect(
      await testDb.query.invoices.findFirst({
        where: { id: { eq: draftId } },
        columns: { documentType: true, totalAmount: true },
      }),
    ).toEqual({ documentType: "invoice", totalAmount: cents(100) });
  });

  test("cumulative credits serialize concurrent reservations and release capacity on void", async () => {
    const originalInvoiceId = await seedOriginal();
    const first = createdId(await createCredit(originalInvoiceId));
    const second = createdId(await createCredit(originalInvoiceId));
    const results = await Promise.all([
      addLine(first, 600),
      addLine(second, 600),
    ]);
    expect(
      results.filter((result) => "code" in result && result.code === 422),
    ).toHaveLength(1);
    const credited = await testDb.query.invoices.findMany({
      where: { id: { in: [first, second] } },
      columns: { id: true, totalAmount: true },
    });
    expect(
      credited.reduce((sum, row) => sum + Math.abs(row.totalAmount), 0),
    ).toBe(726);
    const winner = credited.find((row) => row.totalAmount < 0);
    const loser = credited.find((row) => row.totalAmount === 0);
    if (!winner || !loser) {
      panic("Expected one credit reservation");
    }
    expect(await changeStatus(winner.id, "finalize")).toEqual({
      id: winner.id,
    });
    expect(await changeStatus(winner.id, "void")).toEqual({ id: winner.id });
    expect(await addLine(loser.id, 1000)).toMatchObject({
      totals: { grossAmountMinor: -1210 },
    });
  });

  test("linked credit notes protect original transitions and deletion", async () => {
    const originalInvoiceId = await seedOriginal();
    const creditId = createdId(await createCredit(originalInvoiceId));
    for (const action of ["void", "revert_to_draft"] as const) {
      expect(await changeStatus(originalInvoiceId, action)).toMatchObject({
        code: 409,
      });
    }
    expect(await changeStatus(creditId, "finalize")).toEqual({ id: creditId });
    expect(await changeStatus(creditId, "void")).toEqual({ id: creditId });
    expect(await changeStatus(originalInvoiceId, "revert_to_draft")).toEqual({
      id: originalInvoiceId,
    });
    expect(
      await deleteInvoice.handler(
        contextFor(deleteInvoice.handler, {
          params: { workspaceId: ids.wsA1, invoiceId: originalInvoiceId },
          body: {},
        }),
      ),
    ).toMatchObject({ code: 409 });
  });
});
