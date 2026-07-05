import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import createExpense from "./create";

type CreateExpenseCtx = Parameters<typeof createExpense.handler>[0];

const createContext = ({
  safeDb,
}: {
  safeDb: CreateExpenseCtx["safeDb"];
}): CreateExpenseCtx =>
  asTestRaw<CreateExpenseCtx>({
    body: {
      matterId: toSafeId<"entity">("matter_test"),
      dateIncurred: "2026-07-01",
      timezoneId: "Not/A_Real_Zone",
      amount: 10_000,
      currency: "USD",
      category: "filing_fee",
      description: "test",
    },
    safeDb,
    workspaceId: toSafeId<"workspace">("workspace_test"),
    memberRole: { role: "owner" },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test"),
    },
    user: { id: toSafeId<"user">("user_test") },
    recordAuditEvent: async () => {},
  });

describe("createExpense (timezone validation)", () => {
  test("rejects an invalid IANA timezone id with a 400 instead of throwing", async () => {
    const { getCallCount, safeDb } = createScopedDbMock({
      query: {
        entities: {
          findFirst: () => {
            throw new Error(
              "should not query the matter for an invalid timezone",
            );
          },
        },
      },
    });

    const result = await createExpense.handler(createContext({ safeDb }));

    expect(result).toEqual({
      code: 400,
      response: {
        message: "Invalid timezone identifier",
      },
    });
    expect(getCallCount()).toBe(0);
  });
});
