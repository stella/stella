import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { exportLedesHandler } from "./export-ledes";

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
  status: "approved",
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

const runExport = (rows: unknown[]) =>
  exportLedesHandler({
    scopedDb: scopedDbReturning(rows),
    workspaceId: toSafeId<"workspace">("ws_1"),
    organizationId: toSafeId<"organization">("org_1"),
    query: {},
  });

describe("exportLedesHandler billing integrity", () => {
  test("excludes non-billable and no-charge entries from the LEDES file", async () => {
    const output = await runExport([
      timeEntryRow({ narrative: "Billable work" }),
      timeEntryRow({ billable: false, narrative: "Internal non-billable" }),
      timeEntryRow({ noCharge: true, narrative: "Written off" }),
    ]);

    expect(output).toContain("Billable work");
    expect(output).not.toContain("Internal non-billable");
    expect(output).not.toContain("Written off");
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
});
