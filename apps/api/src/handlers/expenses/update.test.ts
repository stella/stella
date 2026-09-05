import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import updateExpense from "./update";

type UpdateExpenseCtx = Parameters<typeof updateExpense.handler>[0];

/**
 * A currency change with no amount restates the expense, because the stored
 * integer means nothing without its code. Restating can land outside what the
 * new currency's column can carry, and that has to be refused rather than
 * written: three decimals from none multiplies by a thousand.
 */

const existingExpense = (amountCents: number) => ({
  status: "draft",
  dateIncurred: "2026-07-01",
  amount: cents(amountCents),
  currency: "JPY",
  category: "filing_fee",
  description: "test",
  invoiceDescription: null,
  billable: true,
  markup: 0,
  matterId: toSafeId<"entity">("matter_test"),
});

const runUpdate = async (amountCents: number) => {
  const written: Record<string, unknown>[] = [];
  const { getCallCount, safeDb } = createScopedDbMock({
    query: {
      expenses: { findFirst: () => existingExpense(amountCents) },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        written.push(values);
        return { where: async () => await Promise.resolve() };
      },
    }),
  });
  const result = await updateExpense.handler(
    asTestRaw<UpdateExpenseCtx>({
      body: {
        id: toSafeId<"expense">("expense_test"),
        currency: "KWD",
      },
      safeDb,
      workspaceId: toSafeId<"workspace">("workspace_test"),
      memberRole: { role: "owner" },
      session: {
        activeOrganizationId: toSafeId<"organization">("org_test"),
      },
      user: { id: toSafeId<"user">("user_test") },
      recordAuditEvent: async () => {},
    }),
  );
  return { getCallCount, result, written };
};

describe("updateExpense currency restatement range", () => {
  test("refuses a restated amount past the safe integer range", async () => {
    // Fine as a yen amount; a thousand times it is not a number that still
    // names itself once it crosses the API as JSON.
    const { getCallCount, result } = await runUpdate(
      Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1,
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message:
          "This expense cannot be restated in the new currency; " +
          "send the amount in that currency instead",
      },
    });
    // The read that loaded the expense, and nothing after it.
    expect(getCallCount()).toBe(1);
  });

  test("refuses a restated amount the new currency rounds to nothing", async () => {
    // 1 dinar-thousandth cannot come from a currency with a coarser unit
    // going the other way; here 0 yen restated is below the positivity check.
    const { result } = await runUpdate(0);

    expect(result).toMatchObject({ code: 400 });
  });

  test("accepts a restatement that stays inside the range", async () => {
    // 7 yen is 7.000 dinars, so the write carries 7000 rather than the 7 it
    // would keep if the currency changed on its own.
    const { result, written } = await runUpdate(7);

    expect(result).toEqual({ id: toSafeId<"expense">("expense_test") });
    expect(written.at(0)).toMatchObject({ amount: 7000, currency: "KWD" });
  });
});
