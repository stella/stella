import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { roundToBillingIncrement } from "@/api/lib/billing-time";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createTimeEntryHandler } from "./create";

describe("roundToBillingIncrement (billing increment snap)", () => {
  test("ceils to the 6-minute billing increment", () => {
    expect(roundToBillingIncrement(0)).toBe(0);
    expect(roundToBillingIncrement(1)).toBe(6);
    expect(roundToBillingIncrement(6)).toBe(6);
    expect(roundToBillingIncrement(7)).toBe(12);
    expect(roundToBillingIncrement(12)).toBe(12);
    expect(roundToBillingIncrement(13)).toBe(18);
  });

  test("INVARIANT: result is a multiple of 6, >= input, < input + 6", () => {
    for (let m = 0; m <= 600; m++) {
      const r = roundToBillingIncrement(m);
      expect(r % 6).toBe(0);
      expect(r).toBeGreaterThanOrEqual(m);
      expect(r).toBeLessThan(m + 6);
    }
  });
});

describe("createTimeEntryHandler (timezone validation)", () => {
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

    const result = await Result.gen(() =>
      createTimeEntryHandler({
        safeDb,
        organizationId: toSafeId<"organization">("org_test"),
        workspaceId: toSafeId<"workspace">("workspace_test"),
        userId: toSafeId<"user">("user_test"),
        recordAuditEvent: async () => {},
        body: {
          workItemId: toSafeId<"entity">("matter_test"),
          dateWorked: "2026-07-01",
          timezoneId: "Not/A_Real_Zone",
          durationMinutes: 30,
          narrative: "test",
        },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 400,
        message: "Invalid timezone identifier",
      });
    }
    expect(getCallCount()).toBe(0);
  });
});
