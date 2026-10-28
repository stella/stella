import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError, Load } from "@/state/api-request";

/** The person's own timers in the active organization. */
const TIMERS_PATH = "/v1/time-timers";

/** More running and paused timers than anyone keeps at once. */
const TIMERS_PAGE_SIZE = 50;

const timerSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  matterId: v.nullish(v.string()),
  description: v.nullish(v.string()),
  state: v.picklist(["running", "paused"]),
  /** Seconds counted before the timer last resumed. */
  accumulatedSeconds: v.number(),
  /** When a running timer last started counting; null while paused. */
  lastResumedAt: v.nullish(v.string()),
});

const timersPageSchema = v.object({ items: v.array(timerSchema) });

export type Timer = v.InferOutput<typeof timerSchema>;

export type TimersLoad = Load<Timer[]>;

const timerPath = (timerId: string, action?: string) =>
  `${TIMERS_PATH}/${encodeURIComponent(timerId)}${action === undefined ? "" : `/${action}`}`;

/** The person's running and paused timers. */
export const listTimers = async ({
  fetch,
  source,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<Timer[], ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: `${TIMERS_PATH}?limit=${TIMERS_PAGE_SIZE}`,
        schema: timersPageSchema,
        source,
      }),
    );
    return Result.ok(page.items);
  });

/**
 * Starts a timer, on a matter or none, with what is being worked on. The
 * server pauses whichever timer was running, so only one ever counts.
 */
export const startTimer = async ({
  description,
  fetch,
  matterId,
  source,
}: {
  readonly description: string | null;
  readonly fetch: Fetch;
  readonly matterId: string | null;
  readonly source: AccessTokenSource;
}): Promise<Result<Timer, ApiError>> =>
  await requestApi({
    body: { description, matterId },
    fetch,
    path: `${TIMERS_PATH}/start`,
    schema: timerSchema,
    source,
  });

/** Pauses a running timer or resumes a paused one. */
export const toggleTimer = async ({
  fetch,
  source,
  timer,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly timer: Timer;
}): Promise<Result<Timer, ApiError>> =>
  await requestApi({
    fetch,
    method: "POST",
    path: timerPath(timer.id, timer.state === "running" ? "pause" : "resume"),
    schema: timerSchema,
    source,
  });

/**
 * Turns a timer into a draft time entry, dated in `timeZone`, and removes
 * it. A timer without a matter is internal work, which bills nothing.
 */
export const saveTimer = async ({
  fetch,
  source,
  timeZone,
  timer,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly timeZone: string;
  readonly timer: Timer;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: {
          timezoneId: timeZone,
          ...(timer.matterId === null || timer.matterId === undefined
            ? { activityGroup: "internal" }
            : {}),
        },
        fetch,
        path: timerPath(timer.id, "confirm"),
        // Only whether it saved matters; the entry is edited on the web.
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

/** Throws a timer away without recording its time. */
export const discardTimer = async ({
  fetch,
  source,
  timer,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly timer: Timer;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        fetch,
        method: "DELETE",
        path: timerPath(timer.id),
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

/** The seconds a timer has counted by `now`, in epoch milliseconds. */
export const elapsedSeconds = (timer: Timer, now: number): number => {
  if (
    timer.state !== "running" ||
    timer.lastResumedAt === null ||
    timer.lastResumedAt === undefined
  ) {
    return timer.accumulatedSeconds;
  }
  const resumedAt = Temporal.Instant.from(
    timer.lastResumedAt,
  ).epochMilliseconds;
  const since = Math.floor((now - resumedAt) / 1000);
  return timer.accumulatedSeconds + Math.max(0, since);
};

/** Seconds as a clock: 0:05:09, or 12:30:00. */
export const clockOf = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const rest = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
};
