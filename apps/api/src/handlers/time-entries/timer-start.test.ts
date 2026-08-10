import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import timerStart, { buildTimerBillingSnapshot } from "./timer-start";

type TimerStartCtx = Parameters<typeof timerStart.handler>[0];

const createContext = ({
  safeDb,
  timezoneId = "Not/A_Real_Zone",
}: {
  safeDb: TimerStartCtx["safeDb"];
  timezoneId?: string;
}): TimerStartCtx =>
  asTestRaw<TimerStartCtx>({
    body: {
      timezoneId,
    },
    request: new Request("https://stella.test/v1/time-entries/timer/start", {
      method: "POST",
    }),
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
  test("keeps a timer non-billable until it has an effective rate", () => {
    expect(buildTimerBillingSnapshot(null)).toEqual({
      billable: false,
      rateAtEntry: 0,
      currency: "XXX",
    });
    expect(
      buildTimerBillingSnapshot({ hourlyRate: 24_000, currency: "EUR" }),
    ).toEqual({
      billable: true,
      rateAtEntry: 24_000,
      currency: "EUR",
    });
  });

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

  test("translates the global active-timer constraint into a client error", async () => {
    const constraintCause = Object.assign(new Error("unique violation"), {
      errno: PG_ERROR.UNIQUE_VIOLATION,
      constraint: "time_entries_one_active_timer_per_user_idx",
    });
    const databaseError = new DatabaseError({
      message: "Database query failed",
      code: PG_ERROR.UNIQUE_VIOLATION,
      cause: new DrizzleQueryError("insert failed", [], constraintCause),
    });
    let callCount = 0;
    const safeDb = asTestRaw<TimerStartCtx["safeDb"]>(async () => {
      callCount += 1;
      return callCount === 1 ? Result.ok(new Map()) : Result.err(databaseError);
    });

    const result = await timerStart.handler(
      createContext({ safeDb, timezoneId: "Europe/Prague" }),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message: "You already have an active timer. Stop it first.",
      },
    });
    expect(callCount).toBe(2);
  });
});
