import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { TimerActivityTimer } from "@stll/api-contract/timer-activity";

import { timerActivityPushFor } from "@/api/lib/push/timer-activity-payload";

const NOW = Date.parse("2026-11-04T10:00:00Z");
const START_TOKEN = "aa".repeat(32);
const ACTIVITY_TOKEN = "bb".repeat(32);

const device = (
  overrides: Partial<Parameters<typeof timerActivityPushFor>[0]["device"]> = {},
) => ({
  activityToken: ACTIVITY_TOKEN,
  details: true,
  link: "app.stll.preview://timers",
  locale: "cs",
  startToken: START_TOKEN,
  starting: false,
  actions: true,
  ...overrides,
});

const RUNNING: TimerActivityTimer = {
  accumulatedSeconds: 600,
  description: "Call re: share deal",
  id: "t1",
  lastResumedAt: "2026-11-04T09:55:00Z",
  matterId: "m1",
  state: "running",
};

const MATTERS = new Map([["m1", "Novák v. Svoboda"]]);

const propsSchema = v.record(v.string(), v.unknown());

const propsOf = (push: ReturnType<typeof timerActivityPushFor>) =>
  push.type === "none"
    ? null
    : v.parse(propsSchema, JSON.parse(push.payload.aps["content-state"].props));

describe("a Lock Screen update", () => {
  test("updates the activity a phone shows, in its language, with the timer named", () => {
    const push = timerActivityPushFor({
      device: device(),
      matterNames: MATTERS,
      now: NOW,
      timers: [RUNNING],
    });
    expect(push).toMatchObject({
      type: "update",
      token: ACTIVITY_TOKEN,
      payload: {
        aps: {
          event: "update",
          timestamp: NOW / 1000,
          "content-state": { name: "TimerActivity" },
        },
      },
    });
    expect(propsOf(push)).toEqual({
      actionLabel: "Pozastavit",
      actionTarget: "stella-timer:pause:t1",
      actions: true,
      clock: "0:15:00",
      countingFromMs: NOW - 900_000,
      detail: "Novák v. Svoboda",
      link: "app.stll.preview://timers",
      running: true,
      status: "Běží",
      timerId: "t1",
      title: "Call re: share deal",
    });
  });

  test("with details off, carries neither the description nor the matter through Apple", () => {
    const push = timerActivityPushFor({
      device: device({ details: false }),
      matterNames: MATTERS,
      now: NOW,
      timers: [RUNNING],
    });
    expect(propsOf(push)).toMatchObject({ detail: "", title: "Časovač" });
    expect(JSON.stringify(push)).not.toMatch(/share deal|Novák/u);
  });

  test("ends the activity once no timer is left, at once", () => {
    const push = timerActivityPushFor({
      device: device(),
      matterNames: MATTERS,
      now: NOW,
      timers: [],
    });
    expect(push).toMatchObject({
      type: "end",
      token: ACTIVITY_TOKEN,
      payload: { aps: { event: "end", "dismissal-date": NOW / 1000 } },
    });
  });

  test("starts an activity on a phone that shows none, with an alert that names nothing", () => {
    const push = timerActivityPushFor({
      device: device({ activityToken: null }),
      matterNames: MATTERS,
      now: NOW,
      timers: [RUNNING],
    });
    expect(push).toMatchObject({
      type: "start",
      token: START_TOKEN,
      payload: {
        aps: {
          event: "start",
          "attributes-type": "LiveActivityAttributes",
          attributes: { url: "app.stll.preview://timers" },
          alert: {
            title: "Časovač",
            body: "Na jiném zařízení se spustil časovač",
          },
        },
      },
    });
  });

  test.each([
    ["no start token", { activityToken: null, startToken: null }],
    ["a start already sent", { activityToken: null, starting: true }],
  ])("sends nothing to a phone with %s", (_, overrides) => {
    expect(
      timerActivityPushFor({
        device: device(overrides),
        matterNames: MATTERS,
        now: NOW,
        timers: [RUNNING],
      }),
    ).toEqual({ type: "none" });
  });

  test("starts nothing for a paused timer, nor ends an activity a phone does not show", () => {
    const paused = {
      ...RUNNING,
      lastResumedAt: null,
      state: "paused" as const,
    };
    for (const timers of [[paused], []]) {
      expect(
        timerActivityPushFor({
          device: device({ activityToken: null }),
          matterNames: MATTERS,
          now: NOW,
          timers,
        }),
      ).toEqual({ type: "none" });
    }
  });

  test("an unknown language falls back to English", () => {
    const push = timerActivityPushFor({
      device: device({ locale: "xx" }),
      matterNames: MATTERS,
      now: NOW,
      timers: [{ ...RUNNING, description: null, matterId: null }],
    });
    expect(propsOf(push)).toMatchObject({
      status: "Running",
      title: "No description",
    });
  });
});
