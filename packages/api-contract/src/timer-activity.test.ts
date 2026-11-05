import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  clockOf,
  elapsedSeconds,
  TIMER_ACTIVITY_TEXT_MAX_LENGTH,
  timerActivityDeviceRegistrationSchema,
  timerActivityOf,
} from "./timer-activity";
import type {
  TimerActivityDetails,
  TimerActivityLabels,
  TimerActivityTimer,
} from "./timer-activity";

const NOW = Date.parse("2026-10-28T10:00:00Z");

const labels: TimerActivityLabels = {
  more: (count) => `+${count} more`,
  noDescription: "No description",
  noMatter: "No matter",
  paused: "Paused",
  running: "Running",
  timer: "Timer",
};

const timer = (
  fields: Partial<TimerActivityTimer> & Pick<TimerActivityTimer, "id">,
): TimerActivityTimer => ({
  accumulatedSeconds: 0,
  description: null,
  lastResumedAt: null,
  matterId: null,
  state: "paused",
  ...fields,
});

const activity = (
  timers: TimerActivityTimer[],
  details: TimerActivityDetails = "shown",
) =>
  timerActivityOf({
    details,
    labels,
    link: "app.stll.dev://timers",
    matterNames: new Map([["m1", "Novák v. Acme"]]),
    now: NOW,
    timers,
  });

const RUNNING = timer({
  accumulatedSeconds: 600,
  description: "Draft the reply",
  id: "t1",
  lastResumedAt: "2026-10-28T09:55:00Z",
  matterId: "m1",
  state: "running",
});

describe("a timer's time", () => {
  test("a running timer adds the seconds since it resumed", () => {
    expect(elapsedSeconds(RUNNING, NOW)).toBe(600 + 300);
  });

  test("a paused timer keeps what it counted", () => {
    const paused = {
      ...RUNNING,
      lastResumedAt: null,
      state: "paused" as const,
    };
    expect(elapsedSeconds(paused, Date.UTC(2030, 0, 1))).toBe(600);
  });

  test("reads as a clock", () => {
    expect(clockOf(309)).toBe("0:05:09");
    expect(clockOf(45_000)).toBe("12:30:00");
  });
});

describe("the timer's Live Activity", () => {
  test("ends when there are no timers", () => {
    expect(activity([])).toBeNull();
  });

  test("counts a running timer on from when it would have started", () => {
    expect(activity([RUNNING])).toEqual({
      clock: "0:15:00",
      countingFromMs: NOW - 900_000,
      detail: "Novák v. Acme",
      link: "app.stll.dev://timers",
      running: true,
      status: "Running",
      timerId: "t1",
      title: "Draft the reply",
    });
  });

  test("with details hidden, says nothing of the other timers either", () => {
    const shown = activity(
      [RUNNING, timer({ accumulatedSeconds: 60, id: "t2" })],
      "hidden",
    );
    expect(shown?.status).toBe("Running");
  });

  test("shortens on whole characters, never splitting an emoji", () => {
    const shown = activity([
      { ...RUNNING, description: `${"x".repeat(118)}😀${"y".repeat(20)}` },
    ]);
    expect(shown?.title).toBe(`${"x".repeat(118)}…`);
  });

  test("shortens a long description to a line the Lock Screen can carry", () => {
    const shown = activity([{ ...RUNNING, description: "x".repeat(10_000) }]);
    expect(shown?.title.length).toBe(TIMER_ACTIVITY_TEXT_MAX_LENGTH);
    expect(shown?.title.endsWith("…")).toBe(true);
  });

  test("with details hidden, names neither the description nor the matter", () => {
    const shown = activity([RUNNING], "hidden");
    expect(shown).toEqual({
      clock: "0:15:00",
      countingFromMs: NOW - 900_000,
      detail: "",
      link: "app.stll.dev://timers",
      running: true,
      status: "Running",
      timerId: "t1",
      title: "Timer",
    });
    expect(JSON.stringify(shown)).not.toMatch(/Draft|Novák/u);
  });

  test("follows the running timer over paused ones, and says how many more there are", () => {
    const shown = activity([
      timer({ accumulatedSeconds: 7200, id: "paused" }),
      timer({
        id: "running",
        lastResumedAt: "2026-10-28T09:59:00Z",
        state: "running",
      }),
    ]);
    expect(shown?.timerId).toBe("running");
    expect(shown?.status).toBe("+1 more");
  });

  test("with two running, follows the one resumed last", () => {
    const shown = activity([
      timer({
        id: "earlier",
        lastResumedAt: "2026-10-28T08:00:00Z",
        state: "running",
      }),
      timer({
        id: "later",
        lastResumedAt: "2026-10-28T09:00:00Z",
        state: "running",
      }),
    ]);
    expect(shown?.timerId).toBe("later");
  });

  test("with none running, shows the paused timer with the most time, still", () => {
    const shown = activity([
      timer({ accumulatedSeconds: 60, id: "short" }),
      timer({ accumulatedSeconds: 3600, id: "long", matterId: "m1" }),
    ]);
    expect(shown).toMatchObject({
      clock: "1:00:00",
      detail: "",
      running: false,
      timerId: "long",
      title: "Novák v. Acme",
    });
  });

  test("names a timer with neither description nor matter plainly", () => {
    expect(activity([timer({ id: "t" })])?.title).toBe("No description");
    expect(activity([timer({ description: "Call", id: "t" })])?.detail).toBe(
      "No matter",
    );
  });
});

describe("a phone's registration", () => {
  const registration = {
    sequence: 1,
    activity: null,
    bundleId: "app.stll.mobile.preview",
    details: true,
    environment: "production",
    link: "app.stll.preview://timers",
    locale: "cs",
    startToken: "ab".repeat(32),
  };

  test("accepts the app's own link to its timers", () => {
    for (const link of [
      "app.stll.preview://timers",
      "app.stll:///timers",
      "app.stll.dev://expo-development-client/timers",
    ]) {
      expect(
        v.safeParse(timerActivityDeviceRegistrationSchema, {
          ...registration,
          link,
        }).success,
      ).toBe(true);
    }
  });

  test("refuses a link to anywhere else", () => {
    for (const link of [
      "https://example.com/timers",
      "app.stll.preview://timers?next=https://example.com",
      "other.app://timers",
      "app.stll://not-timers",
      "app.stll://matters/timers",
      "app.stll://../timers",
      "app.stll://timers/../settings",
    ]) {
      expect(
        v.safeParse(timerActivityDeviceRegistrationSchema, {
          ...registration,
          link,
        }).success,
      ).toBe(false);
    }
  });
});
