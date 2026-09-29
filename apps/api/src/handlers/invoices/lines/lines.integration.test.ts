import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { calculateDocumentTotals } from "@stll/invoicing";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createInvoice from "@/api/handlers/invoices/create";
import readInvoiceById from "@/api/handlers/invoices/get";
import transitionInvoice from "@/api/handlers/invoices/transition";
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
    };

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
      contextFor<Parameters<typeof createInvoice.handler>[0]>({
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

  test("editing a draft from before invoice lines keeps its attached entries in the total", async () => {
    const legacy = await seedLegacyDraft();
    // A read never writes: the legacy draft shows no lines until an edit.
    expect(await runGet(legacy.invoiceId)).toMatchObject({
      lines: [],
      totalAmount: legacy.totalAmount,
    });

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

const contextFor = <TContext>({
  body,
  params,
  auditEvents = [],
}: {
  body?: unknown;
  params: Record<string, unknown>;
  auditEvents?: AuditEvent[];
}): TContext => {
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
    memberRole: { role: "owner" },
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
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
    contextFor({ body, params: { workspaceId: ids.wsA1, invoiceId } }),
  );

const runUpdate = async (
  invoiceId: SafeId<"invoice">,
  lineId: SafeId<"invoiceLine">,
  body: UpdateBody,
) =>
  await updateInvoiceLine.handler(
    contextFor({ body, params: { workspaceId: ids.wsA1, invoiceId, lineId } }),
  );

const runDelete = async (
  invoiceId: SafeId<"invoice">,
  lineId: SafeId<"invoiceLine">,
) =>
  await deleteInvoiceLine.handler(
    contextFor({ params: { workspaceId: ids.wsA1, invoiceId, lineId } }),
  );

const runGet = async (invoiceId: SafeId<"invoice">) =>
  await readInvoiceById.handler(
    contextFor({ params: { workspaceId: ids.wsA1, invoiceId } }),
  );

const runTransition = async (
  invoiceId: SafeId<"invoice">,
  action: Parameters<typeof transitionInvoice.handler>[0]["body"]["action"],
) =>
  await transitionInvoice.handler(
    contextFor({
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

const seedTimeEntry = async ({ billedMinutes }: { billedMinutes: number }) => {
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
    narrative: "Drafted the response",
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
 * billed, no lines, and the total their billed amounts summed to, which the
 * lines migration copied into `net_amount`.
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
    .set({ totalAmount: cents(totalAmount), netAmount: cents(totalAmount) })
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
  }: {
    source: "manual" | "time_entry" | "expense";
    timeEntryId: SafeId<"timeEntry"> | null;
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
