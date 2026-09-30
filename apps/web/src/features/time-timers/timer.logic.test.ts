import { describe, expect, test } from "bun:test";

import { getFormattingLocale } from "@/i18n/i18n-store";
import { APIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

import {
  elapsedTimerSeconds,
  formatTimerSeconds,
  runningTimer,
  timerErrorKey,
} from "./timer.logic";
import type { TimeTimer } from "./timer.logic";

const RESUMED_AT = "2026-09-30T12:00:00Z";
const RESUMED_AT_MS = Date.parse(RESUMED_AT);
const paused = {
  id: toSafeId<"timeTimer">("timer-paused"),
  matterId: null,
  description: null,
  state: "paused",
  startedAt: "2026-09-29T12:00:00Z",
  accumulatedSeconds: 125,
  lastResumedAt: null,
  createdAt: "2026-09-29T12:00:00Z",
  updatedAt: RESUMED_AT,
} as const satisfies TimeTimer;
const running = {
  id: toSafeId<"timeTimer">("timer-running"),
  matterId: null,
  description: null,
  state: "running",
  startedAt: "2026-09-29T12:00:00Z",
  accumulatedSeconds: 125,
  lastResumedAt: RESUMED_AT,
  createdAt: "2026-09-29T12:00:00Z",
  updatedAt: RESUMED_AT,
} as const satisfies TimeTimer;

describe("timer elapsed time", () => {
  test("paused time stays fixed regardless of the clock", () => {
    for (const delta of [-86_400_000, 0, 999, 86_400_000]) {
      expect(elapsedTimerSeconds(paused, RESUMED_AT_MS + delta)).toBe(125);
    }
  });

  test("running time adds whole seconds since the latest resume and clamps clock skew", () => {
    for (const [delta, expected] of [
      [-60_000, 125],
      [0, 125],
      [999, 125],
      [1000, 126],
      [61_999, 186],
      [86_400_000, 86_525],
    ] as const) {
      expect(elapsedTimerSeconds(running, RESUMED_AT_MS + delta)).toBe(
        expected,
      );
    }
  });

  test("a running timer must have a resume timestamp", () => {
    expect(() =>
      elapsedTimerSeconds({ ...running, lastResumedAt: null }, RESUMED_AT_MS),
    ).toThrow("Running timer has no resume timestamp");
  });
});

describe("timer duration display", () => {
  test("keeps elapsed hours beyond a day and formats every part with the locale", () => {
    const formatter = new Intl.NumberFormat(getFormattingLocale(), {
      numberingSystem: "arab",
      minimumIntegerDigits: 2,
      useGrouping: false,
    });
    expect(
      formatTimerSeconds({
        seconds: 25 * 3600 + 2 * 60 + 3,
        formatNumber: (value) => formatter.format(value),
      }),
    ).toBe("٢٥:٠٢:٠٣");
    expect(
      formatTimerSeconds({
        seconds: 0,
        formatNumber: (value) => formatter.format(value),
      }),
    ).toBe("٠٠:٠٠:٠٠");
  });
});

describe("one running timer", () => {
  test("selects the running timer among paused timers or returns no timer", () => {
    expect(runningTimer([])).toBeUndefined();
    expect(runningTimer([paused])).toBeUndefined();
    expect(runningTimer([paused, running])).toBe(running);
    expect(runningTimer([running, paused])).toBe(running);
  });

  test("rejects multiple running timers", () => {
    expect(() =>
      runningTimer([
        running,
        { ...running, id: toSafeId<"timeTimer">("timer-other") },
      ]),
    ).toThrow("Multiple running timers returned for one user");
  });
});

describe("timer refusal messages", () => {
  test("uses typed API error codes for actionable refusal messages", () => {
    for (const [code, expected] of [
      ["narrative_required", "billing.globalTimer.narrativeRequired"],
      ["time_period_locked", "billing.globalTimer.periodLocked"],
      ["timer_matter_required", "billing.matterRequired"],
      ["timer_matter_inaccessible", "billing.globalTimer.matterInaccessible"],
      [
        "timer_original_entry_inaccessible",
        "billing.globalTimer.matterInaccessible",
      ],
      ["timer_not_running", "billing.globalTimer.timerUnavailable"],
      ["timer_completion_changed", "billing.globalTimer.timerUnavailable"],
    ] as const) {
      expect(
        timerErrorKey(new APIError({ code, status: 409, message: "Refused" })),
      ).toBe(expected);
    }
  });

  test("leaves unrelated and untyped errors to normal error handling", () => {
    expect(
      timerErrorKey(new APIError({ status: 500, message: "Failed" })),
    ).toBeNull();
    expect(
      timerErrorKey(
        new APIError({ code: "unknown", status: 409, message: "Failed" }),
      ),
    ).toBeNull();
    expect(
      timerErrorKey({
        code: "narrative_required",
        status: 409,
        message: "Refused",
      }),
    ).toBeNull();
    expect(timerErrorKey(null)).toBeNull();
  });
});
