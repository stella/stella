import { describe, expect, test } from "bun:test";

import { BILLING_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import deleteExpense from "./delete";

type DeleteExpenseCtx = Parameters<typeof deleteExpense.handler>[0];

const createContext = ({
  safeDb,
  scopedDb,
}: {
  safeDb: DeleteExpenseCtx["safeDb"];
  scopedDb: DeleteExpenseCtx["scopedDb"];
}): DeleteExpenseCtx =>
  asTestRaw<DeleteExpenseCtx>({
    body: { id: toSafeId<"expense">("expense_test") },
    safeDb,
    scopedDb,
    workspaceId: toSafeId<"workspace">("workspace_test"),
    memberRole: { role: "owner" },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test"),
    },
    user: { id: toSafeId<"user">("user_test") },
    recordAuditEvent: async () => {},
  });

describe("deleteExpense", () => {
  test("rejects deleting a billed expense", async () => {
    const { getCallCount, safeDb, scopedDb } = createScopedDbMock({
      query: {
        expenses: {
          findFirst: async () => ({
            status: BILLING_STATUS.BILLED,
            amount: 10_000,
            currency: "USD",
            category: "filing",
            matterId: toSafeId<"entity">("matter_test"),
            dateIncurred: "2026-06-14",
          }),
        },
      },
      delete: () => {
        throw new Error("delete should not be called for billed expenses");
      },
      update: () => {
        throw new Error("update should not be called for billed expenses");
      },
    });

    const result = await deleteExpense.handler(
      createContext({ safeDb, scopedDb }),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message: "Cannot delete a billed expense; revert the invoice first",
      },
    });
    expect(getCallCount()).toBe(1);
  });
});
