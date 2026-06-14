import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { BILLING_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
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

const runExport = async (rows: unknown[]) =>
  await exportLedesHandler({
    scopedDb: scopedDbReturning(rows),
    workspaceId: toSafeId<"workspace">("ws_1"),
    organizationId: toSafeId<"organization">("org_1"),
    query: {},
  });

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

    const output = await exportLedesHandler({
      scopedDb,
      workspaceId: toSafeId<"workspace">("ws_1"),
      organizationId: toSafeId<"organization">("org_1"),
      query: {},
    });

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
