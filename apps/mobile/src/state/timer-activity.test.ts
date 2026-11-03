import { describe, expect, test } from "bun:test";

import { timerActivityOf } from "./timer-activity";
import type { TimerActivityLabels } from "./timer-activity";
import { clockOf } from "./timers";
import type { Timer } from "./timers";

const NOW = Date.parse("2026-10-28T10:00:00Z");

const labels: TimerActivityLabels = {
  more: (count) => `+${count} more`,
  noDescription: "No description",
  noMatter: "No matter",
  paused: "Paused",
  running: "Running",
};

const timer = (fields: Partial<Timer> & Pick<Timer, "id">): Timer => ({
  accumulatedSeconds: 0,
  description: null,
  lastResumedAt: null,
  matterId: null,
  state: "paused",
  ...fields,
});

const activity = (
  timers: Timer[],
  matterNames = new Map([["m1", "Novák v. Acme"]]),
) =>
  timerActivityOf({
    clockOf,
    labels,
    link: "app.stll.dev://timers",
    matterNames,
    now: NOW,
    timers,
  });

describe("the timer's Live Activity", () => {
  test("ends when there are no timers", () => {
    expect(activity([])).toBeNull();
  });

  test("counts a running timer on from when it would have started", () => {
    const shown = activity([
      timer({
        accumulatedSeconds: 600,
        description: "Draft the reply",
        id: "t1",
        lastResumedAt: "2026-10-28T09:55:00Z",
        matterId: "m1",
        state: "running",
      }),
    ]);
    expect(shown).toEqual({
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
