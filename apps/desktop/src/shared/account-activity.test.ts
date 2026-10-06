import { describe, expect, test } from "bun:test";

import { shouldRecordAccountActivity } from "./account-activity";

const activity = {
  windowLabel: "clipboard",
  visibilityState: "visible",
  eventType: "pointerdown",
  isTrusted: true,
  now: 30_000,
  lastRecordedAt: null,
} as const;

describe("account activity eligibility", () => {
  for (const windowLabel of ["main", "clipboard", "clipboard-editor"]) {
    for (const eventType of ["pointerdown", "keydown"]) {
      test(`${windowLabel} accepts visible trusted ${eventType}`, () => {
        expect(
          shouldRecordAccountActivity({ ...activity, windowLabel, eventType }),
        ).toBe(true);
      });
    }
  }
  for (const eventType of [
    "focus",
    "visibilitychange",
    "mousemove",
    "timer",
    "poll",
    "keydown",
    "pointerdown",
  ]) {
    test(`${eventType} cannot record synthetic or hidden activity`, () => {
      expect(
        shouldRecordAccountActivity({
          ...activity,
          eventType,
          isTrusted: false,
        }),
      ).toBe(false);
      expect(
        shouldRecordAccountActivity({
          ...activity,
          eventType,
          visibilityState: "hidden",
        }),
      ).toBe(false);
      if (eventType !== "keydown" && eventType !== "pointerdown") {
        expect(shouldRecordAccountActivity({ ...activity, eventType })).toBe(
          false,
        );
      }
    });
  }
  test("other native surfaces never record activity", () => {
    for (const windowLabel of [
      "",
      "takeover-dialog",
      "self-host-connect-dialog",
      "unknown",
    ]) {
      expect(shouldRecordAccountActivity({ ...activity, windowLabel })).toBe(
        false,
      );
    }
  });
  test("the thirty-second boundary permits one paced use rather than each input", () => {
    for (const elapsed of [-1, 0, 1, 29_999]) {
      expect(
        shouldRecordAccountActivity({
          ...activity,
          now: 30_000 + elapsed,
          lastRecordedAt: 30_000,
        }),
      ).toBe(false);
    }
    for (const elapsed of [30_000, 30_001, 60_000]) {
      expect(
        shouldRecordAccountActivity({
          ...activity,
          now: 30_000 + elapsed,
          lastRecordedAt: 30_000,
        }),
      ).toBe(true);
    }
  });
});
