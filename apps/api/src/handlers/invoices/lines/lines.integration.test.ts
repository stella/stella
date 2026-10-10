import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";

import { calculateDocumentTotals } from "@stll/invoicing";

import { user as authUser } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import deleteExpense from "@/api/handlers/expenses/delete";
import updateExpense from "@/api/handlers/expenses/update";
import createInvoice from "@/api/handlers/invoices/create";
import addEntries from "@/api/handlers/invoices/entries/add";
import readInvoiceById from "@/api/handlers/invoices/get";
import transitionInvoice from "@/api/handlers/invoices/transition";
import batchUpdateTimeEntries from "@/api/handlers/time-entries/batch/update";
import { exportCsvHandler } from "@/api/handlers/time-entries/csv/export";
import deleteTimeEntryById from "@/api/handlers/time-entries/delete";
import { exportLedesHandler } from "@/api/handlers/time-entries/ledes/export";
import { exportPdfHandler } from "@/api/handlers/time-entries/pdf/export";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditEvent,
  type FieldDiffs,
} from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createInvoiceLine from "./create";
import deleteInvoiceLine from "./delete";
import updateInvoiceLine from "./update";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const seededInvoiceIds: SafeId<"invoice">[] = [];
const seededTimeEntryIds: SafeId<"timeEntry">[] = [];
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
    if (seededInvoiceIds.length > 0) {
      await testDb
        .delete(invoiceLines)
        .where(inArray(invoiceLines.invoiceId, seededInvoiceIds));
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

const STANDARD_RATE = 2100;
const REDUCED_RATE = 1200;

describe("invoice lines", () => {
  test("totals and the VAT breakdown of a mixed-rate invoice come from the invoicing package", async () => {
    const invoiceId = await seedInvoice();
    const timeEntryId = await seedTimeEntry({ billedMinutes: 90 });

    await expectCreated(
      invoiceId,
      manual({ quantity: "2", unitPriceMinor: 12_345 }, STANDARD_RATE),
    );
    await expectCreated(
      invoiceId,
      manual({ quantity: "1.5", unitPriceMinor: 999 }, REDUCED_RATE),
    );
    await expectCreated(invoiceId, {
      source: { type: "time_entry", timeEntryId },
      vatRateBps: STANDARD_RATE,
      vatTreatment: "domestic_vat",
    });

    const detail = await runGet(invoiceId);
    const expected = calculateDocumentTotals({
      documentType: "invoice",
      lines: [
        {
          description: "a",
          netAmountMinor: cents(24_690),
          vatRateBps: STANDARD_RATE,
          vatTreatment: "domestic_vat",
        },
        {
          description: "b",
          netAmountMinor: cents(1499),
          vatRateBps: REDUCED_RATE,
          vatTreatment: "domestic_vat",
        },
        {
          // 90 minutes at 20_000 per hour.
          description: "c",
          netAmountMinor: cents(30_000),
          vatRateBps: STANDARD_RATE,
          vatTreatment: "domestic_vat",
        },
      ],
    }).unwrap().totals;

    expect(detail).toMatchObject({
      totals: expected,
      netAmount: expected.netAmountMinor,
      vatAmount: expected.vatAmountMinor,
      totalAmount: expected.grossAmountMinor,
    });
    expect(expected.vatBreakdown).toHaveLength(2);
    expect(
      readLines(detail).map((line) => [
        line.position,
        line.source,
        line.quantity,
        line.netAmount,
      ]),
    ).toEqual([
      [0, "manual", "2.0000", 24_690],
      [1, "manual", "1.5000", 1499],
      [2, "time_entry", "1.5000", 30_000],
    ]);
  });

  test("keeps amounts above 32-bit integers exact end to end", async () => {
    const invoiceId = await seedInvoice();
    const unitPriceMinor = 2 ** 31 + 7;

    await expectCreated(
      invoiceId,
      manual({ quantity: "3", unitPriceMinor }, STANDARD_RATE),
    );

    const [line] = await testDb
      .select({
        unitPrice: invoiceLines.unitPrice,
        netAmount: invoiceLines.netAmount,
      })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId));
    expect(line).toEqual({
      unitPrice: cents(unitPriceMinor),
      netAmount: cents(unitPriceMinor * 3),
    });
    const [invoice] = await testDb
      .select({ totalAmount: invoices.totalAmount })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    // 21 % of 6_442_450_965, rounded half up, added to the net.
    expect(invoice?.totalAmount).toBe(cents(6_442_450_965 + 1_352_914_703));
  });

  test("the source must match exactly one entry reference", async () => {
    const invoiceId = await seedInvoice();
    const timeEntryId = await seedTimeEntry({ billedMinutes: 60 });

    await expectFailure(
      insertLineRow(invoiceId, { source: "manual", timeEntryId }),
      "invoice_lines_source_reference_check",
    );
    await expectFailure(
      insertLineRow(invoiceId, { source: "time_entry", timeEntryId: null }),
      "invoice_lines_source_reference_check",
    );
    await expectFailure(
      insertLineRow(invoiceId, { source: "expense", timeEntryId }),
      "invoice_lines_source_reference_check",
    );
    await expectFailure(
      insertLineRow(invoiceId, { source: "expense", timeEntryId: null }),
      "invoice_lines_source_reference_check",
    );
    // Only a released line may outlive its source.
    await insertLineRow(invoiceId, {
      source: "time_entry",
      timeEntryId: null,
      releasedAt: new Date(),
    });
    await expectFailure(
      insertLineRow(invoiceId, {
        source: "manual",
        timeEntryId,
        releasedAt: new Date(),
      }),
      "invoice_lines_source_reference_check",
    );
  });

  test("a time entry is billed on at most one line until its invoice is voided", async () => {
    const firstInvoiceId = await seedInvoice();
    const secondInvoiceId = await seedInvoice();
    const timeEntryId = await seedTimeEntry({ billedMinutes: 60 });
    const entryLine = {
      source: { type: "time_entry", timeEntryId },
      vatRateBps: 0,
      vatTreatment: "domestic_vat",
    } as const;

    await expectCreated(firstInvoiceId, entryLine);
    expect(await runCreate(secondInvoiceId, entryLine)).toMatchObject({
      code: 400,
    });

    // The partial unique index holds even for a writer that skips the claim.
    await testDb
      .update(timeEntries)
      .set({ invoiceId: null, status: BILLING_STATUS.APPROVED })
      .where(eq(timeEntries.id, timeEntryId));
    expect(await runCreate(secondInvoiceId, entryLine)).toMatchObject({
      code: 409,
    });
    await expectFailure(
      insertLineRow(secondInvoiceId, { source: "time_entry", timeEntryId }),
      "invoice_lines_time_entry_billed_uidx",
    );
    await testDb
      .update(timeEntries)
      .set({ invoiceId: firstInvoiceId, status: BILLING_STATUS.BILLED })
      .where(eq(timeEntries.id, timeEntryId));

    await setStatus(firstInvoiceId, INVOICE_STATUS.FINALIZED);
    expect(await runTransition(firstInvoiceId, "void")).toEqual({
      id: firstInvoiceId,
    });

    await expectCreated(secondInvoiceId, entryLine);
    const voided = readLines(await runGet(firstInvoiceId));
    expect(voided).toHaveLength(1);
    expect(voided[0]?.releasedAt).not.toBeNull();
  });

  test("a voided invoice keeps its lines when their entries are later deleted", async () => {
    const invoiceId = await seedInvoice();
    const timeEntryId = await seedTimeEntry({ billedMinutes: 60 });
    const expenseId = await seedExpense({ amount: 10_000, markup: 10 });
    await expectCreated(invoiceId, {
      source: { type: "time_entry", timeEntryId },
      vatRateBps: STANDARD_RATE,
      vatTreatment: "domestic_vat",
    });
    await expectCreated(invoiceId, {
      source: { type: "expense", expenseId },
      vatRateBps: STANDARD_RATE,
      vatTreatment: "domestic_vat",
    });
    const readRows = async () =>
      await testDb
        .select({
          source: invoiceLines.source,
          timeEntryId: invoiceLines.timeEntryId,
          expenseId: invoiceLines.expenseId,
          releasedAt: invoiceLines.releasedAt,
          description: invoiceLines.description,
          netAmount: invoiceLines.netAmount,
          vatAmount: invoiceLines.vatAmount,
          grossAmount: invoiceLines.grossAmount,
        })
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId))
        .orderBy(invoiceLines.position);

    // While the invoice bills them, neither entry can go: the handlers refuse
    // a billed source, and the database refuses to orphan a live line.
    expect(
      await deleteTimeEntryById.handler(
        contextFor(deleteTimeEntryById.handler, {
          body: { id: timeEntryId },
          params: { workspaceId: ids.wsA1 },
        }),
      ),
    ).toMatchObject({ code: 400 });
    await expectFailure(
      testDb.delete(expenses).where(eq(expenses.id, expenseId)),
      "invoice_lines_source_reference_check",
    );

    await setStatus(invoiceId, INVOICE_STATUS.FINALIZED);
    expect(await runTransition(invoiceId, "void")).toEqual({ id: invoiceId });
    const released = await readRows();
    expect(released.map((row) => row.releasedAt)).not.toContain(null);

    // Back to draft the way the product does it, then deleted outright.
    expect(
      await batchUpdateTimeEntries.handler(
        contextFor(batchUpdateTimeEntries.handler, {
          body: { ids: [timeEntryId], action: "revert_to_draft" },
          params: { workspaceId: ids.wsA1 },
        }),
      ),
    ).toEqual({ updated: 1 });
    expect(
      await updateExpense.handler(
        contextFor(updateExpense.handler, {
          body: { id: expenseId, status: BILLING_STATUS.DRAFT },
          params: { workspaceId: ids.wsA1 },
        }),
      ),
    ).toEqual({ id: expenseId });
    expect(
      await deleteTimeEntryById.handler(
        contextFor(deleteTimeEntryById.handler, {
          body: { id: timeEntryId },
          params: { workspaceId: ids.wsA1 },
        }),
      ),
    ).toEqual({ deleted: true });
    expect(
      await deleteExpense.handler(
        contextFor(deleteExpense.handler, {
          body: { id: expenseId },
          params: { workspaceId: ids.wsA1 },
        }),
      ),
    ).toEqual({ deleted: true });

    expect(await readRows()).toEqual(
      released.map((row) => ({ ...row, timeEntryId: null, expenseId: null })),
    );
    expect(released.map((row) => row.netAmount)).toEqual([
      cents(20_000),
      cents(11_000),
    ]);
  });

  test("lines of a non-draft invoice cannot change", async () => {
    const invoiceId = await seedInvoice();
    const lineId = await expectCreated(
      invoiceId,
      manual({ quantity: "1", unitPriceMinor: 1000 }, STANDARD_RATE),
    );
    await setStatus(invoiceId, INVOICE_STATUS.FINALIZED);
    const refused = {
      code: 409,
      response: { message: "Invoice not found or not in draft status" },
    } as const;

    expect(
      await runCreate(
        invoiceId,
        manual({ quantity: "1", unitPriceMinor: 1 }, STANDARD_RATE),
      ),
    ).toEqual(refused);
    expect(await runUpdate(invoiceId, lineId, { vatRateBps: 0 })).toEqual(
      refused,
    );
    expect(await runDelete(invoiceId, lineId)).toEqual(refused);
    expect(readLines(await runGet(invoiceId))).toMatchObject([
      { id: lineId, vatRateBps: STANDARD_RATE, netAmount: 1000 },
    ]);
  });

  test("an entry line keeps the entry's amount and releases the entry when removed", async () => {
    const invoiceId = await seedInvoice();
    const expenseId = await seedExpense({ amount: 10_000, markup: 10 });
    const lineId = await expectCreated(invoiceId, {
      source: { type: "expense", expenseId },
      vatRateBps: STANDARD_RATE,
      vatTreatment: "domestic_vat",
    });

    expect(
      await runUpdate(invoiceId, lineId, { unitPriceMinor: 1 }),
    ).toMatchObject({ code: 400 });
    expect(
      await runUpdate(invoiceId, lineId, { vatRateBps: REDUCED_RATE }),
    ).toMatchObject({
      totals: {
        netAmountMinor: 11_000,
        vatAmountMinor: 1320,
        grossAmountMinor: 12_320,
      },
    });

    expect(await runDelete(invoiceId, lineId)).toMatchObject({
      totals: { grossAmountMinor: 0 },
    });
    expect(
      await testDb.query.expenses.findFirst({
        where: { id: { eq: expenseId } },
        columns: { invoiceId: true, status: true },
      }),
    ).toEqual({ invoiceId: null, status: BILLING_STATUS.APPROVED });
  });

  test("creating an invoice from time entries stores one line per entry", async () => {
    const first = await seedTimeEntry({ billedMinutes: 60 });
    const second = await seedTimeEntry({ billedMinutes: 10 });

    const created = await createInvoice.handler(
      contextFor(createInvoice.handler, {
        body: {
          invoiceNumber: `INV-LINES-${createSafeId<"invoice">()}`,
          invoiceDate: "2026-09-29",
          currency: "USD",
          timeEntryIds: [first, second],
        },
        params: { workspaceId: ids.wsA1 },
      }),
    );
    const invoiceId = readId(created, "invoice");
    seededInvoiceIds.push(invoiceId);

    // 10 minutes at 20_000 per hour is 3333.33, billed as 3333.
    expect(created).toMatchObject({ totalAmount: 23_333, entryCount: 2 });
    expect(
      readLines(await runGet(invoiceId)).map((line) => [
        line.timeEntryId,
        line.quantity,
        line.netAmount,
      ]),
    ).toEqual([
      [first, "1.0000", 20_000],
      [second, "0.1667", 3333],
    ]);
  });

  test.each(["create", "add", "line"] as const)(
    "%s retains no-charge time at zero alongside charged time",
    async (path) => {
      const free = await seedTimeEntry({ billedMinutes: 60, noCharge: true });
      const charged = await seedTimeEntry({ billedMinutes: 60 });
      const dateWorked = {
        create: "2026-07-21",
        add: "2026-07-22",
        line: "2026-07-23",
      }[path];
      await testDb
        .update(timeEntries)
        .set({ dateWorked })
        .where(inArray(timeEntries.id, [free, charged]));
      let invoiceId: SafeId<"invoice">;
      if (path === "create") {
        const created = await createInvoice.handler(
          contextFor(createInvoice.handler, {
            body: {
              invoiceNumber: `INV-NC-${free}`,
              invoiceDate: "2026-09-29",
              currency: "USD",
              timeEntryIds: [free, charged],
            },
            params: { workspaceId: ids.wsA1 },
          }),
        );
        expect(created).toMatchObject({ totalAmount: 20_000, entryCount: 2 });
        invoiceId = readId(created, "invoice");
        seededInvoiceIds.push(invoiceId);
      } else {
        invoiceId = await seedInvoice();
        if (path === "add") {
          expect(await runAddEntries(invoiceId, [free, charged])).toMatchObject(
            { totalAmount: 20_000 },
          );
        } else {
          for (const timeEntryId of [free, charged]) {
            await expectCreated(invoiceId, {
              source: { type: "time_entry", timeEntryId },
              vatRateBps: STANDARD_RATE,
              vatTreatment: "domestic_vat",
            });
          }
        }
      }
      const detail = await runGet(invoiceId);
      expect(detail).toMatchObject({
        netAmount: 20_000,
        totalAmount: path === "line" ? 24_200 : 20_000,
      });
      expect(
        readLines(detail).map((line) => [line.timeEntryId, line.netAmount]),
      ).toEqual([
        [free, 0],
        [charged, 20_000],
      ]);
      const stored = await testDb.query.invoiceLines.findMany({
        where: { invoiceId: { eq: invoiceId } },
        orderBy: { position: "asc" },
      });
      expect(
        stored.map((line) => [
          line.unitPrice,
          line.netAmount,
          line.grossAmount,
        ]),
      ).toEqual([
        [cents(0), cents(0), cents(0)],
        [
          cents(20_000),
          cents(20_000),
          cents(path === "line" ? 24_200 : 20_000),
        ],
      ]);
      const exportContext = {
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        scopedDb: asTestRaw<ScopedDb>(
          createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
        ),
        query: {
          workItemId: ids.entityA1,
          dateFrom: dateWorked,
          dateTo: dateWorked,
        },
      };
      const csv = await exportCsvHandler(exportContext);
      const courtesy = csv
        .split("\n")
        .filter((row) => row.includes("Courtesy work"));
      expect(courtesy).toHaveLength(1);
      expect(courtesy.every((row) => row.includes(",200.00,USD,0.00,"))).toBe(
        true,
      );
      const pdf = new TextDecoder().decode(
        await exportPdfHandler(exportContext),
      );
      expect(pdf).toContain("Rate: USD 200.00/hr  Amount: USD 0.00");
      expect(pdf).toContain("Total Amount: USD 200.00");
      const ledes = await exportLedesHandler(exportContext);
      const ledesText = ledes.unwrap();
      expect(ledesText).not.toContain("Courtesy work");
      expect(ledesText).toContain("|200.00|");
      expect(ledesText).toContain("Drafted the response");
    },
  );

  test("reading an invoice from before invoice lines totals its attached entries", async () => {
    const legacy = await seedLegacyDraft();
    const legacyTotals = {
      lines: [],
      totalAmount: legacy.totalAmount,
      netAmount: legacy.totalAmount,
      vatAmount: 0,
      totals: {
        netAmountMinor: legacy.totalAmount,
        vatAmountMinor: 0,
        grossAmountMinor: legacy.totalAmount,
      },
    };

    // A read never writes: no lines appear, but the totals count the entries.
    expect(await runGet(legacy.invoiceId)).toMatchObject(legacyTotals);
    await setStatus(legacy.invoiceId, INVOICE_STATUS.FINALIZED);
    expect(await runGet(legacy.invoiceId)).toMatchObject(legacyTotals);
    expect(await readStoredAmounts(legacy.invoiceId)).toEqual({
      netAmount: null,
      vatAmount: null,
    });
  });

  test("a voided invoice from before invoice lines reads its stored total", async () => {
    const invoiceId = await seedInvoice();
    await testDb
      .update(invoices)
      .set({ totalAmount: cents(5000), status: INVOICE_STATUS.VOID })
      .where(eq(invoices.id, invoiceId));

    expect(await runGet(invoiceId)).toMatchObject({
      lines: [],
      netAmount: 5000,
      vatAmount: 0,
      totals: {
        netAmountMinor: 5000,
        vatAmountMinor: 0,
        grossAmountMinor: 5000,
      },
    });
  });

  test("editing a draft from before invoice lines keeps its attached entries in the total", async () => {
    const legacy = await seedLegacyDraft();

    // 1000 net at 21 % is 1210 gross.
    const created = await runCreate(
      legacy.invoiceId,
      manual({ quantity: "1", unitPriceMinor: 1000 }, STANDARD_RATE),
    );
    expect(created).toMatchObject({
      totals: { grossAmountMinor: legacy.totalAmount + 1210 },
    });

    const detail = await runGet(legacy.invoiceId);
    expect(detail).toMatchObject({ totalAmount: legacy.totalAmount + 1210 });
    // The recalculation stores the amounts a legacy invoice lacked.
    expect(await readStoredAmounts(legacy.invoiceId)).toEqual({
      netAmount: cents(legacy.totalAmount + 1000),
      vatAmount: cents(210),
    });
    expect(
      readLines(detail).map((line) => [
        line.position,
        line.source,
        line.timeEntryId ?? line.expenseId,
        line.netAmount,
        line.vatRateBps,
      ]),
    ).toEqual([
      ...legacy.timeEntries.map((entry, index) => [
        index,
        "time_entry",
        entry.id,
        entry.netAmount,
        0,
      ]),
      [2, "expense", legacy.expenseId, 11_000, 0],
      [3, "manual", null, 1000, STANDARD_RATE],
    ]);
  });

  test("materialising a legacy draft's entry lines happens once", async () => {
    const legacy = await seedLegacyDraft();
    const lineId = await expectCreated(
      legacy.invoiceId,
      manual({ quantity: "1", unitPriceMinor: 1000 }, STANDARD_RATE),
    );

    expect(
      await runUpdate(legacy.invoiceId, lineId, { vatRateBps: 0 }),
    ).toMatchObject({
      totals: { grossAmountMinor: legacy.totalAmount + 1000 },
    });
    await expectCreated(
      legacy.invoiceId,
      manual({ quantity: "2", unitPriceMinor: 50 }, 0),
    );

    const lines = await testDb
      .select({
        source: invoiceLines.source,
        timeEntryId: invoiceLines.timeEntryId,
        expenseId: invoiceLines.expenseId,
      })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, legacy.invoiceId));
    expect(lines).toHaveLength(5);
    expect(
      lines
        .map((line) => line.timeEntryId ?? line.expenseId)
        .filter((id) => id !== null)
        .toSorted(),
    ).toEqual(
      [
        ...legacy.timeEntries.map((entry) => entry.id),
        legacy.expenseId,
      ].toSorted(),
    );
    const [invoice] = await testDb
      .select({ totalAmount: invoices.totalAmount })
      .from(invoices)
      .where(eq(invoices.id, legacy.invoiceId));
    expect(invoice?.totalAmount).toBe(cents(legacy.totalAmount + 1100));
  });

  test("line changes audit the lines and totals they write", async () => {
    const legacy = await seedLegacyDraft();
    const invoiceEvent = (
      changes: FieldDiffs,
      metadata?: Record<string, unknown>,
    ) => ({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: legacy.invoiceId,
      changes,
      ...(metadata ? { metadata } : {}),
    });
    const backfill = { materialisedFromAttachedEntries: true };

    const createEvents: AuditEvent[] = [];
    const lineId = readId(
      await createInvoiceLine.handler(
        contextFor(createInvoiceLine.handler, {
          body: manual({ quantity: "1", unitPriceMinor: 1000 }, STANDARD_RATE),
          params: { workspaceId: ids.wsA1, invoiceId: legacy.invoiceId },
          auditEvents: createEvents,
        }),
      ),
      "invoiceLine",
    );
    expect(createEvents).toEqual([
      // The first edit backfills the attached entries' lines and stores the
      // net and VAT a legacy draft lacked; its gross total was already right.
      invoiceEvent(
        {
          linesAdded: {
            old: null,
            new: [
              ...legacy.timeEntries.map((entry) => ({
                id: expect.any(String),
                source: "time_entry",
                netAmount: entry.netAmount,
                vatRateBps: 0,
              })),
              {
                id: expect.any(String),
                source: "expense",
                netAmount: 11_000,
                vatRateBps: 0,
              },
            ],
          },
        },
        backfill,
      ),
      invoiceEvent({
        netAmount: { old: null, new: legacy.totalAmount },
        vatAmount: { old: null, new: 0 },
      }),
      invoiceEvent({
        linesAdded: {
          old: null,
          new: [
            {
              id: lineId,
              source: "manual",
              netAmount: 1000,
              vatRateBps: STANDARD_RATE,
            },
          ],
        },
      }),
      invoiceEvent({
        netAmount: { old: legacy.totalAmount, new: legacy.totalAmount + 1000 },
        vatAmount: { old: 0, new: 210 },
        totalAmount: {
          old: legacy.totalAmount,
          new: legacy.totalAmount + 1210,
        },
      }),
    ]);

    // Nothing is left to backfill: the delete records its totals and itself.
    const deleteEvents: AuditEvent[] = [];
    await deleteInvoiceLine.handler(
      contextFor(deleteInvoiceLine.handler, {
        params: { workspaceId: ids.wsA1, invoiceId: legacy.invoiceId, lineId },
        auditEvents: deleteEvents,
      }),
    );
    expect(deleteEvents).toEqual([
      invoiceEvent({
        netAmount: { old: legacy.totalAmount + 1000, new: legacy.totalAmount },
        vatAmount: { old: 210, new: 0 },
        totalAmount: {
          old: legacy.totalAmount + 1210,
          new: legacy.totalAmount,
        },
      }),
      invoiceEvent({
        lineRemoved: {
          old: { id: lineId, source: "manual", netAmount: 1000 },
          new: null,
        },
      }),
    ]);
  });

  test("a line patch that omits the VAT treatment keeps it", async () => {
    const invoiceId = await seedInvoice();
    const lineId = await expectCreated(invoiceId, {
      ...manual({ quantity: "1", unitPriceMinor: 1000 }, 0),
      vatTreatment: "reverse_charge",
    });

    // Through Elysia's own validation, which fills absent fields it coerces.
    const body = await parseUpdateBody({ description: "Revised advice" });
    expect(body).toEqual({ description: "Revised advice" });
    await runUpdate(invoiceId, lineId, body);

    expect(readLines(await runGet(invoiceId))).toMatchObject([
      {
        id: lineId,
        description: "Revised advice",
        vatTreatment: "reverse_charge",
      },
    ]);
  });

  test("attaching entries cannot take an invoice past its line limit", async () => {
    const invoiceId = await seedInvoice();
    await testDb.insert(invoiceLines).values(
      Array.from({ length: LIMITS.invoiceLinesPerInvoice - 1 }, (_, index) => ({
        ...lineRowValues(invoiceId, { source: "manual", timeEntryId: null }),
        position: index,
      })),
    );
    const first = await seedTimeEntry({ billedMinutes: 60 });
    const second = await seedTimeEntry({ billedMinutes: 30 });

    expect(await runAddEntries(invoiceId, [first, second])).toEqual({
      code: 400,
      response: {
        message: `An invoice holds at most ${LIMITS.invoiceLinesPerInvoice} lines`,
      },
    });
    expect(
      await testDb.query.timeEntries.findMany({
        where: { id: { in: [first, second] } },
        columns: { invoiceId: true },
      }),
    ).toEqual([{ invoiceId: null }, { invoiceId: null }]);

    // One more still fits: the limit is inclusive.
    expect(await runAddEntries(invoiceId, [first])).toMatchObject({
      totalAmount: expect.any(Number),
    });
    expect(
      await testDb.$count(invoiceLines, eq(invoiceLines.invoiceId, invoiceId)),
    ).toBe(LIMITS.invoiceLinesPerInvoice);
  });

  test("row-level security keeps another organization's lines out of reach", async () => {
    const invoiceId = await seedInvoice();
    await expectCreated(
      invoiceId,
      manual({ quantity: "1", unitPriceMinor: 500 }, STANDARD_RATE),
    );
    const otherOrgDb = createScopedDb(testDb, [ids.wsB1], ids.orgB, ids.userB1);

    const visible = await otherOrgDb((tx) =>
      tx
        .select({ id: invoiceLines.id })
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId)),
    );
    expect(visible).toEqual([]);
    await expectFailure(
      otherOrgDb((tx) =>
        tx.insert(invoiceLines).values({
          ...lineRowValues(invoiceId, { source: "manual", timeEntryId: null }),
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
        }),
      ),
      "row-level security",
    );
  });
});

type LineBody = Parameters<typeof createInvoiceLine.handler>[0]["body"];
type UpdateBody = Parameters<typeof updateInvoiceLine.handler>[0]["body"];

const manual = (
  amount: { quantity: string; unitPriceMinor: number },
  vatRateBps: number,
): LineBody => ({
  source: { type: "manual", description: "Advice", ...amount },
  vatRateBps,
  vatTreatment: "domestic_vat",
});

const contextFor = <TContext>(
  _handler: (handlerContext: TContext) => unknown,
  {
    body,
    params,
    auditEvents = [],
  }: {
    body?: unknown;
    params: Record<string, unknown>;
    auditEvents?: AuditEvent[];
  },
): TContext => {
  const recordAuditEvent = async (
    _tx: unknown,
    events: AuditEvent | AuditEvent[],
  ) => {
    auditEvents.push(...(Array.isArray(events) ? events : [events]));
  };
  return asTestRaw<TContext>({
    getActiveWorkspaceIds: async () => [ids.wsA1],
    getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
    getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
    body,
    createAuditRecorder: () => recordAuditEvent,
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
    params,
    promptCachingEnabled: false,
    recordAuditEvent,
    request: new Request(`https://example.test/workspaces/${ids.wsA1}`),
    route: "/test/invoices/lines",
    safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  });
};

const runCreate = async (invoiceId: SafeId<"invoice">, body: LineBody) =>
  await createInvoiceLine.handler(
    contextFor(createInvoiceLine.handler, {
      body,
      params: { workspaceId: ids.wsA1, invoiceId },
    }),
  );

const runUpdate = async (
  invoiceId: SafeId<"invoice">,
  lineId: SafeId<"invoiceLine">,
  body: UpdateBody,
) =>
  await updateInvoiceLine.handler(
    contextFor(updateInvoiceLine.handler, {
      body,
      params: { workspaceId: ids.wsA1, invoiceId, lineId },
    }),
  );

const runDelete = async (
  invoiceId: SafeId<"invoice">,
  lineId: SafeId<"invoiceLine">,
) =>
  await deleteInvoiceLine.handler(
    contextFor(deleteInvoiceLine.handler, {
      params: { workspaceId: ids.wsA1, invoiceId, lineId },
    }),
  );

const runAddEntries = async (
  invoiceId: SafeId<"invoice">,
  timeEntryIds: SafeId<"timeEntry">[],
) =>
  await addEntries.handler(
    contextFor(addEntries.handler, {
      body: { timeEntryIds },
      params: { workspaceId: ids.wsA1, invoiceId },
    }),
  );

/** The body the handler receives after Elysia validates the request. */
const parseUpdateBody = async (
  body: Record<string, unknown>,
): Promise<UpdateBody> => {
  let parsed: unknown = null;
  const app = new Elysia().patch(
    "/line",
    ({ body: received }) => {
      parsed = received;
      return "ok";
    },
    { body: updateInvoiceLine.config.body },
  );
  const response = await app.handle(
    new Request("http://localhost/line", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  return asTestRaw<UpdateBody>(parsed);
};

const readStoredAmounts = async (invoiceId: SafeId<"invoice">) =>
  await testDb.query.invoices.findFirst({
    where: { id: { eq: invoiceId } },
    columns: { netAmount: true, vatAmount: true },
  });

const runGet = async (invoiceId: SafeId<"invoice">) =>
  await readInvoiceById.handler(
    contextFor(readInvoiceById.handler, {
      params: { workspaceId: ids.wsA1, invoiceId },
    }),
  );

const runTransition = async (
  invoiceId: SafeId<"invoice">,
  action: Parameters<typeof transitionInvoice.handler>[0]["body"]["action"],
) =>
  await transitionInvoice.handler(
    contextFor(transitionInvoice.handler, {
      body: { action },
      params: { workspaceId: ids.wsA1, invoiceId },
    }),
  );

const readId = <T extends "invoice" | "invoiceLine">(
  result: unknown,
  _type: T,
): SafeId<T> => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string"
  ) {
    throw new Error(`Expected a created id, got ${JSON.stringify(result)}`);
  }
  return asTestRaw<SafeId<T>>(result.id);
};

const expectCreated = async (invoiceId: SafeId<"invoice">, body: LineBody) =>
  readId(await runCreate(invoiceId, body), "invoiceLine");

type ReadLine = {
  id: string;
  position: number;
  description: string;
  vatTreatment: string;
  source: string;
  quantity: string;
  netAmount: number;
  vatRateBps: number;
  timeEntryId: string | null;
  expenseId: string | null;
  releasedAt: string | null;
};

const readLines = (detail: unknown): ReadLine[] => {
  if (
    typeof detail !== "object" ||
    detail === null ||
    !("lines" in detail) ||
    !Array.isArray(detail.lines)
  ) {
    throw new Error(`Expected invoice detail, got ${JSON.stringify(detail)}`);
  }
  return asTestRaw<ReadLine[]>(detail.lines);
};

const seedInvoice = async () => {
  const invoiceId = createSafeId<"invoice">();
  seededInvoiceIds.push(invoiceId);
  await testDb.insert(invoices).values({
    id: invoiceId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    invoiceNumber: `INV-LINES-${invoiceId}`,
    invoiceDate: "2026-09-29",
    currency: "USD",
    status: INVOICE_STATUS.DRAFT,
  });
  return invoiceId;
};

const setStatus = async (
  invoiceId: SafeId<"invoice">,
  status: (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS],
) => {
  await testDb
    .update(invoices)
    .set({ status })
    .where(eq(invoices.id, invoiceId));
};

const seedTimeEntry = async ({
  billedMinutes,
  noCharge = false,
}: {
  billedMinutes: number;
  noCharge?: boolean;
}) => {
  const id = createSafeId<"timeEntry">();
  seededTimeEntryIds.push(id);
  await testDb.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    workItemId: ids.entityA1,
    dateWorked: "2026-09-28",
    timezoneId: "UTC",
    durationMinutes: billedMinutes,
    billedMinutes,
    rateAtEntry: cents(20_000),
    currency: "USD",
    narrative: noCharge ? "Courtesy work" : "Drafted the response",
    noCharge,
    status: BILLING_STATUS.APPROVED,
  });
  return id;
};

const seedExpense = async ({
  amount,
  markup,
}: {
  amount: number;
  markup: number;
}) => {
  const id = createSafeId<"expense">();
  seededExpenseIds.push(id);
  await testDb.insert(expenses).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    matterId: ids.entityA1,
    dateIncurred: "2026-09-28",
    amount: cents(amount),
    markup,
    currency: "USD",
    category: "filing_fee",
    description: "Court fee",
    status: BILLING_STATUS.APPROVED,
  });
  return id;
};

/**
 * A draft as the code before invoice lines left it: entries attached and
 * billed, no lines, the total their billed amounts summed to, and no stored
 * net or VAT amount.
 */
const seedLegacyDraft = async () => {
  const invoiceId = await seedInvoice();
  const first = await seedTimeEntry({ billedMinutes: 60 });
  const second = await seedTimeEntry({ billedMinutes: 10 });
  const expenseId = await seedExpense({ amount: 10_000, markup: 10 });
  await testDb
    .update(timeEntries)
    .set({ invoiceId, status: BILLING_STATUS.BILLED })
    .where(inArray(timeEntries.id, [first, second]));
  await testDb
    .update(expenses)
    .set({ invoiceId, status: BILLING_STATUS.BILLED })
    .where(eq(expenses.id, expenseId));
  // 60 minutes at 20_000 per hour, 10 minutes billed as 3333, and the
  // expense with its 10 % markup.
  const totalAmount = 20_000 + 3333 + 11_000;
  await testDb
    .update(invoices)
    .set({ totalAmount: cents(totalAmount) })
    .where(eq(invoices.id, invoiceId));
  // Lines materialise in a stable order: entries by date, then id.
  const timeEntryLines = [
    { id: first, netAmount: 20_000 },
    { id: second, netAmount: 3333 },
  ].toSorted((a, b) => (a.id < b.id ? -1 : 1));
  return { invoiceId, timeEntries: timeEntryLines, expenseId, totalAmount };
};

const lineRowValues = (
  invoiceId: SafeId<"invoice">,
  {
    source,
    timeEntryId,
    releasedAt = null,
  }: {
    source: "manual" | "time_entry" | "expense";
    timeEntryId: SafeId<"timeEntry"> | null;
    releasedAt?: Date | null;
  },
) => ({
  organizationId: ids.orgA,
  workspaceId: ids.wsA1,
  invoiceId,
  position: 99,
  description: "Direct write",
  quantity: "1",
  unitPrice: cents(100),
  vatRateBps: 0,
  vatTreatment: "domestic_vat" as const,
  netAmount: cents(100),
  vatAmount: cents(0),
  grossAmount: cents(100),
  source,
  timeEntryId,
  releasedAt,
});

const insertLineRow = async (
  invoiceId: SafeId<"invoice">,
  line: Parameters<typeof lineRowValues>[1],
) => {
  await testDb.insert(invoiceLines).values(lineRowValues(invoiceId, line));
};

const errorChainText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    parts.push(current.message);
    if ("constraint" in current && typeof current.constraint === "string") {
      parts.push(current.constraint);
    }
    current = current.cause;
  }
  return parts.join("\n");
};

/** Awaits a write that must fail and names what refused it. */
const expectFailure = async (write: Promise<unknown>, fragment: string) => {
  let failure: unknown = null;
  try {
    await write;
  } catch (error) {
    failure = error;
  }
  expect(errorChainText(failure)).toContain(fragment);
};
