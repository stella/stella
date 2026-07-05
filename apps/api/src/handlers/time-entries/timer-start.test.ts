import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import timerStart from "./timer-start";

type TimerStartCtx = Parameters<typeof timerStart.handler>[0];

const createContext = ({
  safeDb,
}: {
  safeDb: TimerStartCtx["safeDb"];
}): TimerStartCtx =>
  asTestRaw<TimerStartCtx>({
    body: {
      matterId: toSafeId<"entity">("matter_test"),
      timezoneId: "Not/A_Real_Zone",
      rateAtEntry: 10_000,
      currency: "USD",
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

describe("timerStart (timezone validation)", () => {
  test("rejects an invalid IANA timezone id with a 400 instead of throwing", async () => {
    const { getCallCount, safeDb } = createScopedDbMock({
      $count: () => {
        throw new Error(
          "should not query the active timer count for an invalid timezone",
        );
      },
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

    const result = await timerStart.handler(createContext({ safeDb }));

    expect(result).toEqual({
      code: 400,
      response: {
        message: "Invalid timezone identifier",
      },
    });
    expect(getCallCount()).toBe(0);
  });
});
