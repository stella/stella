import { describe, expect, test } from "bun:test";

import { DESKTOP_HANDOFF_FAILURE_REASONS } from "@stll/api-contract/desktop-handoff";

import { resolveDesktopEditHandoffStatus } from "./desktop-edit-handoffs.logic";

describe("desktop edit handoff status", () => {
  test("keeps consumed handoffs pending past the original handoff expiry", () => {
    const status = resolveDesktopEditHandoffStatus({
      failedAt: null,
      failureReason: null,
      consumedAt: new Date("2026-05-13T12:00:30.000Z"),
      desktopSessionId: null,
      expiresAt: new Date("2026-05-13T12:00:00.000Z"),
      now: new Date("2026-05-13T12:01:00.000Z"),
      openedAt: null,
    });

    expect(status).toEqual({
      status: "pending",
      expiresAt: "2026-05-13T12:01:30.000Z",
    });
  });

  test("expires consumed handoffs after the open acknowledgement grace period", () => {
    const status = resolveDesktopEditHandoffStatus({
      failedAt: null,
      failureReason: null,
      consumedAt: new Date("2026-05-13T12:00:30.000Z"),
      desktopSessionId: null,
      expiresAt: new Date("2026-05-13T12:00:00.000Z"),
      now: new Date("2026-05-13T12:01:30.000Z"),
      openedAt: null,
    });

    expect(status).toEqual({
      status: "expired",
      expiresAt: "2026-05-13T12:01:30.000Z",
    });
  });
});

for (const failureReason of DESKTOP_HANDOFF_FAILURE_REASONS) {
  test(`returns ${failureReason} immediately and preserves it after expiry`, () => {
    const failedAt = new Date("2026-05-13T12:00:00.000Z");
    for (const now of [failedAt, new Date("2026-05-13T12:05:00.000Z")]) {
      expect(
        resolveDesktopEditHandoffStatus({
          consumedAt: null,
          desktopSessionId: null,
          expiresAt: new Date("2026-05-13T12:01:00.000Z"),
          failedAt,
          failureReason,
          now,
          openedAt: null,
        }),
      ).toEqual({
        status: "failed",
        failureReason,
        failedAt: failedAt.toISOString(),
      });
    }
  });
}
