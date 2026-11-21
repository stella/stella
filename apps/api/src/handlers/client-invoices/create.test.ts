import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

import { clientInvoiceBody } from "./create-contract";

const bodyWith = ({
  timeEntryCount,
  expenseCount,
}: {
  timeEntryCount: number;
  expenseCount: number;
}) => ({
  invoiceDate: "2026-10-18",
  currency: "EUR",
  matters: [
    {
      workspaceId: createSafeId<"workspace">(),
      timeEntryIds: Array.from({ length: timeEntryCount }, () =>
        createSafeId<"timeEntry">(),
      ),
      expenseIds: Array.from({ length: expenseCount }, () =>
        createSafeId<"expense">(),
      ),
    },
  ],
});

describe("client invoice request body", () => {
  test("accepts the per-kind source limit for one matter", () => {
    expect(
      v.is(
        clientInvoiceBody,
        bodyWith({
          timeEntryCount: LIMITS.invoiceSourceItemsPerKind,
          expenseCount: LIMITS.invoiceSourceItemsPerKind,
        }),
      ),
    ).toBe(true);
  });

  test("rejects one time entry over the per-kind source limit", () => {
    expect(
      v.is(
        clientInvoiceBody,
        bodyWith({
          timeEntryCount: LIMITS.invoiceSourceItemsPerKind + 1,
          expenseCount: 0,
        }),
      ),
    ).toBe(false);
  });

  test("rejects one expense over the per-kind source limit", () => {
    expect(
      v.is(
        clientInvoiceBody,
        bodyWith({
          timeEntryCount: 0,
          expenseCount: LIMITS.invoiceSourceItemsPerKind + 1,
        }),
      ),
    ).toBe(false);
  });
});
