import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import timerStop from "./stop";

type TimerStopCtx = Parameters<typeof timerStop.handler>[0];

afterEach(() => setSystemTime());

describe("timerStop", () => {
  test("stops a timer after its start date leaves the edit window", async () => {
    setSystemTime(new Date("2026-09-02T00:01:00.000Z"));
    const startedAt = new Date("2026-09-01T23:59:00.000Z");
    let updatedBilledMinutes: number | undefined;
    const { safeDb } = createScopedDbMock({
      query: {
        organizationSettings: {
          findFirst: async () => ({
            timeMinimumUnitMinutes: 15,
            timeEditWindowDays: 0,
            timeLockedThroughMonth: null,
            timeNarrativeRequired: true,
          }),
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [
                {
                  id: toSafeId<"timeEntry">("entry_test"),
                  dateWorked: "2026-09-01",
                  timerStartedAt: startedAt,
                },
              ],
            }),
          }),
        }),
      }),
      update: () => ({
        set: (values: { billedMinutes: number }) => {
          updatedBilledMinutes = values.billedMinutes;
          return { where: async () => {} };
        },
      }),
    });
    const context = asTestRaw<TimerStopCtx>({
      safeDb,
      session: { activeOrganizationId: toSafeId<"organization">("org_test") },
      user: { id: toSafeId<"user">("user_test") },
      workspaceId: toSafeId<"workspace">("workspace_test"),
      memberRole: { role: "member" },
      recordAuditEvent: async () => {},
    });

    expect(await timerStop.handler(context)).toEqual({
      id: toSafeId<"timeEntry">("entry_test"),
      durationMinutes: 2,
      billedMinutes: 15,
    });
    expect(updatedBilledMinutes).toBe(15);
  });
});
