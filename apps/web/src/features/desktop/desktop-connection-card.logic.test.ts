import { describe, expect, test } from "bun:test";

import type { DesktopPresence } from "@stll/api-contract/desktop-presence";

import {
  desktopCardState,
  offersDesktopSetup,
} from "@/features/desktop/desktop-connection-card.logic";

const desktop = {
  version: "1.4.0",
  protocol: 3,
  lastSeenAt: "2026-10-14T19:00:00.000Z",
};
const presences: (DesktopPresence | undefined)[] = [
  undefined,
  { type: "none" },
  { type: "not_connected", desktop },
  { type: "current", desktop },
  { type: "outdated", desktop },
];

describe("desktop connection card", () => {
  test("a pending approval wins over every other signal", () => {
    for (const presence of presences) {
      expect(desktopCardState({ challengeWaiting: true, presence })).toEqual({
        type: "approve",
      });
    }
  });

  test("the server's record of a linked app decides connected or outdated", () => {
    expect(
      desktopCardState({
        challengeWaiting: false,
        presence: { type: "current", desktop },
      }),
    ).toEqual({ type: "connected", version: "1.4.0", onThisComputer: false });
    expect(
      desktopCardState({
        challengeWaiting: false,
        presence: { type: "outdated", desktop },
      }),
    ).toEqual({ type: "outdated", version: "1.4.0" });
  });

  test("without a link or a pending approval, the card offers install or connect", () => {
    for (const presence of [
      undefined,
      { type: "none" } as const,
      { type: "not_connected", desktop } as const,
    ]) {
      expect(desktopCardState({ challengeWaiting: false, presence })).toEqual({
        type: "missing",
      });
    }
  });

  test("a link on another computer still offers install and connect here", () => {
    const card = desktopCardState({
      challengeWaiting: false,
      presence: { type: "current", desktop },
    });
    expect(offersDesktopSetup(card)).toBe(true);
    expect(
      offersDesktopSetup({
        type: "connected",
        version: "",
        onThisComputer: true,
      }),
    ).toBe(false);
    expect(offersDesktopSetup({ type: "approve" })).toBe(false);
  });
});
