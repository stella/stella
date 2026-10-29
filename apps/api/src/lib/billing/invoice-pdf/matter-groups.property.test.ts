import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { groupInvoiceLinesByMatter } from "./matter-groups";
import type { RenderInvoicePdfOptions } from "./render-helpers";

const line = fc
  .record({
    workspaceId: fc.constantFrom("matter-one", "matter-two", "matter-three"),
    // Equal names must never merge distinct matters.
    workspaceName: fc.constant("Legal services"),
    description: fc.string({ maxLength: 20 }),
    quantity: fc.constant(null),
    unit: fc.constant(null),
    unitPrice: fc.constant(null),
    netAmount: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    vatAmount: fc.integer({ min: -210_000, max: 210_000 }),
    vatRateBps: fc.constant(2100),
  })
  .map(
    (value) =>
      ({
        ...value,
        vatTreatment: "domestic_vat" as const,
        grossAmount: value.netAmount + value.vatAmount,
      }) satisfies RenderInvoicePdfOptions["invoice"]["lines"][number],
  );

test("matter shares partition every invoice line and preserve invoice totals", () => {
  assertProperty(
    "matter shares partition every invoice line and preserve invoice totals",
    fc.property(fc.array(line, { maxLength: 50 }), (lines) => {
      const groups = groupInvoiceLinesByMatter(lines);
      expect(groups.map(({ workspaceId }) => workspaceId)).toEqual([
        ...new Set(lines.map(({ workspaceId }) => workspaceId)),
      ]);
      for (const group of groups) {
        expect(group.lines).toEqual(
          lines.filter(({ workspaceId }) => workspaceId === group.workspaceId),
        );
        expect(group.grossAmount).toBe(group.netAmount + group.vatAmount);
      }
      for (const amount of ["netAmount", "vatAmount", "grossAmount"] as const) {
        expect(groups.reduce((sum, group) => sum + group[amount], 0)).toBe(
          lines.reduce((sum, value) => sum + value[amount], 0),
        );
      }
    }),
  );
});
