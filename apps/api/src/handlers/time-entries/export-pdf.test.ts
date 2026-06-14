import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { exportPdfHandler } from "./export-pdf";

const timeEntryRow = (overrides: Record<string, unknown> = {}) => ({
  id: toSafeId<"timeEntry">("te_1"),
  userId: "user_1",
  matterId: toSafeId<"entity">("ent_1"),
  dateWorked: "2026-06-14",
  durationMinutes: 120,
  billedMinutes: 60,
  rateAtEntry: 10_000,
  currency: "USD",
  narrative: "Work",
  invoiceNarrative: null,
  billable: true,
  status: "approved",
  ...overrides,
});

const scopedDbReturning = (rows: unknown[]): ScopedDb => {
  let call = 0;
  return asTestRaw<ScopedDb>(async () => {
    call += 1;
    return call === 1 ? rows : [{ id: "user_1", name: "Alice" }];
  });
};

describe("exportPdfHandler totals", () => {
  test("Total Hours reconciles with billed minutes, not raw duration", async () => {
    // Two rows: 60 billed minutes each (durationMinutes is intentionally
    // larger). Total should be 2.00 billed hours, never 4.00 duration hours.
    const pdf = await exportPdfHandler({
      scopedDb: scopedDbReturning([timeEntryRow(), timeEntryRow()]),
      workspaceId: toSafeId<"workspace">("ws_1"),
      organizationId: toSafeId<"organization">("org_1"),
      query: {},
    });

    const text = new TextDecoder().decode(pdf);
    expect(text).toContain("Total Hours: 2.00");
    expect(text).not.toContain("Total Hours: 4.00");
  });
});
