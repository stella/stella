import { expect, test } from "bun:test";

import { DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL } from "@stll/api-contract/desktop-handoff";
import { DESKTOP_PRESENCE_POLICY } from "@stll/api-contract/desktop-presence";

import { classifyDesktopPresence } from "./service";

const now = new Date("2026-10-05T08:00:00.000Z");
const freshBoundary = new Date(
  now.getTime() - DESKTOP_PRESENCE_POLICY.freshnessSeconds * 1000,
);

test("presence distinguishes never reported, fresh supported, fresh outdated and disconnected", () => {
  expect(classifyDesktopPresence(undefined, now)).toEqual({ type: "none" });
  for (const [protocol, lastSeenAt, type] of [
    [DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL, now, "current"],
    [DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL, freshBoundary, "current"],
    [DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL - 1, now, "outdated"],
    [DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL - 1, freshBoundary, "outdated"],
    [
      DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL,
      new Date(freshBoundary.getTime() - 1),
      "not_connected",
    ],
    [
      DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL - 1,
      new Date(freshBoundary.getTime() - 1),
      "not_connected",
    ],
  ] as const) {
    const row = { version: "0.9.48", protocol, lastSeenAt };
    expect(classifyDesktopPresence(row, now)).toEqual({
      type,
      desktop: {
        version: row.version,
        protocol,
        lastSeenAt: lastSeenAt.toISOString(),
      },
    });
  }
});
