import { panic } from "better-result";

import { Temporal } from "@stll/time";

import type { TranslationKey } from "@/i18n/types";
import type { WebApiRoutes } from "@/lib/eden-client";
import { APIError } from "@/lib/errors/api";

export type TimeTimer =
  WebApiRoutes["time-timers"]["get"]["response"][200]["items"][number];

export const elapsedTimerSeconds = (timer: TimeTimer, now: number) => {
  switch (timer.state) {
    case "paused":
      return timer.accumulatedSeconds;
    case "running": {
      if (timer.lastResumedAt === null) {
        return panic("Running timer has no resume timestamp");
      }
      return (
        timer.accumulatedSeconds +
        Math.max(
          0,
          Math.floor(
            (now -
              Temporal.Instant.from(timer.lastResumedAt).epochMilliseconds) /
              1000,
          ),
        )
      );
    }
    default:
      timer.state satisfies never;
      return panic("Unknown timer state");
  }
};

type FormatTimerSecondsOptions = {
  seconds: number;
  formatNumber: (value: number) => string;
};
export const formatTimerSeconds = ({
  seconds,
  formatNumber,
}: FormatTimerSecondsOptions) =>
  [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map(formatNumber)
    .join(":");

export const runningTimer = (timers: TimeTimer[]) => {
  const running = timers.filter((timer) => timer.state === "running");
  if (running.length > 1) {
    return panic("Multiple running timers returned for one user");
  }
  return running.at(0);
};

const TIMER_REFUSALS = {
  narrative_required: "billing.globalTimer.narrativeRequired",
  time_period_locked: "billing.globalTimer.periodLocked",
  timer_matter_required: "billing.matterRequired",
  timer_matter_inaccessible: "billing.globalTimer.matterInaccessible",
  timer_original_entry_inaccessible: "billing.globalTimer.matterInaccessible",
  timer_not_running: "billing.globalTimer.timerUnavailable",
  timer_completion_changed: "billing.globalTimer.timerUnavailable",
} as const satisfies Record<string, TranslationKey>;

const isTimerRefusal = (code: string): code is keyof typeof TIMER_REFUSALS =>
  Object.hasOwn(TIMER_REFUSALS, code);
export const timerErrorKey = (error: unknown) =>
  APIError.is(error) && error.code !== undefined && isTimerRefusal(error.code)
    ? TIMER_REFUSALS[error.code]
    : null;
