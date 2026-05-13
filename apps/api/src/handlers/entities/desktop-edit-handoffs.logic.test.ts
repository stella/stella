import { describe, expect, test } from "bun:test";

import { resolveDesktopEditHandoffStatus } from "./desktop-edit-handoffs.logic";

describe("desktop edit handoff status", () => {
  test("keeps consumed handoffs pending past the original handoff expiry", () => {
    const status = resolveDesktopEditHandoffStatus({
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
