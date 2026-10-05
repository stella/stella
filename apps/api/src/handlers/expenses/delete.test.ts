import { describe, expect, test } from "bun:test";

import { BILLING_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import deleteExpense from "./delete";

type DeleteExpenseCtx = Parameters<typeof deleteExpense.handler>[0];

const createContext = ({
  safeDb,
  scopedDb,
}: {
  safeDb: DeleteExpenseCtx["safeDb"];
  scopedDb: DeleteExpenseCtx["scopedDb"];
}): DeleteExpenseCtx =>
  withTimeBillingEnrolment(
    asTestRaw<DeleteExpenseCtx>({
      body: { id: toSafeId<"expense">("expense_test") },
      request: new Request("https://example.test/v1/expenses/workspace_test", {
        method: "DELETE",
      }),
      route: "/v1/expenses/:workspaceId",
      safeDb,
      scopedDb,
      workspaceId: toSafeId<"workspace">("workspace_test"),
      memberRole: sessionMemberRole("owner"),
      session: {
        activeOrganizationId: toSafeId<"organization">("org_test"),
      },
      user: { id: toSafeId<"user">("user_test") },
      recordAuditEvent: async () => {},
    }),
  );

describe("deleteExpense", () => {
  test("rejects deleting a billed expense", async () => {
    const { getCallCount, safeDb, scopedDb } = createScopedDbMock({
      select: () =>
        createSelectQueryMock([
          {
            status: BILLING_STATUS.BILLED,
            amount: 10_000,
            currency: "USD",
            category: "filing",
            matterId: toSafeId<"entity">("matter_test"),
            dateIncurred: "2026-06-14",
          },
        ]),
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
