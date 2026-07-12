import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { BILLING_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { escapeLedesField, exportLedesHandler } from "./export-ledes";

const timeEntryRow = (overrides: Record<string, unknown> = {}) => ({
  id: toSafeId<"timeEntry">("te_1"),
  userId: "user_1",
  matterId: toSafeId<"entity">("ent_1"),
  dateWorked: "2026-06-14",
  durationMinutes: 60,
  billedMinutes: 60,
  rateAtEntry: 10_000,
  currency: "USD",
  narrative: "Work",
  invoiceNarrative: null,
  billable: true,
  noCharge: false,
  status: BILLING_STATUS.APPROVED,
  taskCode: null,
  activityCode: null,
  ...overrides,
});

// First scopedDb call returns the time-entry rows; the second returns the
// timekeeper name join. The SQL WHERE is not executed by the mock, which is
// exactly why the handler also carries a defensive in-loop billing guard.
const scopedDbReturning = (rows: unknown[]): ScopedDb => {
  let call = 0;
  return asTestRaw<ScopedDb>(async () => {
    call += 1;
    return call === 1 ? rows : [{ id: "user_1", name: "Alice" }];
  });
};

const runExportResult = async (rows: unknown[]) =>
  await exportLedesHandler({
    scopedDb: scopedDbReturning(rows),
    workspaceId: toSafeId<"workspace">("ws_1"),
    organizationId: toSafeId<"organization">("org_1"),
    query: {},
  });

const runExport = async (rows: unknown[]) => {
  const result = await runExportResult(rows);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("exportLedesHandler billing integrity", () => {
  test("excludes non-billable, no-charge, and written-off entries from the LEDES file", async () => {
    const output = await runExport([
      timeEntryRow({ narrative: "Billable work" }),
      timeEntryRow({ billable: false, narrative: "Internal non-billable" }),
      timeEntryRow({ noCharge: true, narrative: "Written off" }),
      timeEntryRow({
        narrative: "Deleted approved time",
        status: BILLING_STATUS.WRITTEN_OFF,
      }),
    ]);

    expect(output).toContain("Billable work");
    expect(output).not.toContain("Internal non-billable");
    expect(output).not.toContain("Written off");
    expect(output).not.toContain("Deleted approved time");
  });

  test("emits one line item per billable charged entry", async () => {
    const output = await runExport([
      timeEntryRow({ narrative: "First" }),
      timeEntryRow({ narrative: "Second" }),
    ]);

    const dataLines = output
      .split("\n")
      .filter((line) => line.endsWith("[]") && !line.startsWith("LEDES1998B"))
      // drop the header row (starts with INVOICE_DATE)
      .filter((line) => !line.startsWith("INVOICE_DATE"));

    expect(dataLines).toHaveLength(2);
  });

  test("emits the batch total and billing period identically on every row, unaffected by a skipped line", async () => {
    const output = await runExport([
      timeEntryRow({
        dateWorked: "2026-06-10",
        billedMinutes: 60,
        rateAtEntry: 10_000, // $100.00 line total
        narrative: "First",
      }),
      // Non-billable: must not contribute to the total or widen the period.
      timeEntryRow({
        dateWorked: "2026-01-01",
        billable: false,
        narrative: "Skipped",
      }),
      timeEntryRow({
        dateWorked: "2026-06-20",
        billedMinutes: 120,
        rateAtEntry: 15_000, // $300.00 line total
        narrative: "Second",
      }),
    ]);

    const dataLines = output
      .split("\n")
      .filter((line) => line.endsWith("[]") && !line.startsWith("LEDES1998B"))
      .filter((line) => !line.startsWith("INVOICE_DATE"));

    expect(dataLines).toHaveLength(2);

    // Batch total is the sum of the two included lines ($100 + $300), not
    // either line's individual total; the skipped non-billable line does
    // not affect it.
    const expectedInvoiceTotal = "400.00";
    // Billing period spans the two included lines' dates only; the skipped
    // line's earlier date must not widen the period.
    const expectedStart = "20260610";
    const expectedEnd = "20260620";

    for (const line of dataLines) {
      const fields = line.replace(/\[\]$/u, "").split("|");
      expect(fields[4]).toBe(expectedInvoiceTotal); // INVOICE_TOTAL
      expect(fields[5]).toBe(expectedStart); // BILLING_START_DATE
      expect(fields[6]).toBe(expectedEnd); // BILLING_END_DATE
    }

    // Per-line fields still vary: LINE_ITEM_TOTAL (index 12) differs from
    // INVOICE_TOTAL and from each other.
    const firstFields = (dataLines[0] ?? "").replace(/\[\]$/u, "").split("|");
    const secondFields = (dataLines[1] ?? "").replace(/\[\]$/u, "").split("|");
    expect(firstFields[12]).toBe("100.00");
    expect(secondFields[12]).toBe("300.00");
  });

  test("fails fast on a mixed-currency batch instead of emitting a cross-currency total", async () => {
    // LEDES 1998B has no currency field: a batch spanning USD and EUR has
    // no representable INVOICE_TOTAL, so the export must refuse outright.
    const result = await runExportResult([
      timeEntryRow({ currency: "USD", narrative: "Dollar work" }),
      timeEntryRow({ currency: "EUR", narrative: "Euro work" }),
    ]);

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      throw new TypeError("Expected mixed-currency export to fail");
    }
    expect(result.error).toBeInstanceOf(HandlerError);
    if (!(result.error instanceof HandlerError)) {
      throw new TypeError("Expected a handler error");
    }
    expect(result.error.status).toBe(400);
    expect(result.error.message).toContain("single currency");
  });

  test("neutralizes delimiter injection in narrative and timekeeper name", async () => {
    let call = 0;
    const scopedDb = asTestRaw<ScopedDb>(async () => {
      call += 1;
      return call === 1
        ? [
            timeEntryRow({
              narrative: "first line\nspurious|F|999",
              userId: "user_1",
            }),
          ]
        : [{ id: "user_1", name: "Eve|Hacker" }];
    });

    const result = await exportLedesHandler({
      scopedDb,
      workspaceId: toSafeId<"workspace">("ws_1"),
      organizationId: toSafeId<"organization">("org_1"),
      query: {},
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    const output = result.value;

    // One entry must remain exactly one record line: the narrative newline
    // must not inject a second line.
    const dataLines = output
      .split("\n")
      .filter((line) => line.endsWith("[]") && !line.startsWith("LEDES1998B"))
      .filter((line) => !line.startsWith("INVOICE_DATE"));
    expect(dataLines).toHaveLength(1);

    // Delimiters in user-controlled fields are replaced with spaces.
    expect(output).toContain("first line spurious F 999");
    expect(output).toContain("Eve Hacker");
    expect(output).not.toContain("Eve|Hacker");
  });
});

describe("escapeLedesField", () => {
  test("replaces pipes, newlines, and carriage returns with spaces", () => {
    expect(escapeLedesField("a|b")).toBe("a b");
    expect(escapeLedesField("line1\nline2")).toBe("line1 line2");
    expect(escapeLedesField("a\r\nb")).toBe("a  b");
    expect(escapeLedesField("a|b\nc|d")).toBe("a b c d");
  });

  test("leaves ordinary text untouched", () => {
    expect(escapeLedesField("Regular narrative, with punctuation.")).toBe(
      "Regular narrative, with punctuation.",
    );
    expect(escapeLedesField("")).toBe("");
  });
});
