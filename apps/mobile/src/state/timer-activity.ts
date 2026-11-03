import { Temporal } from "temporal-polyfill/full";

import { elapsedSeconds } from "@/state/timers";
import type { Timer } from "@/state/timers";

/**
 * What the Lock Screen and the Dynamic Island show for the person's timers.
 * Plain values only: they cross into the widget extension as JSON.
 */
export type TimerActivityProps = {
  readonly timerId: string;
  readonly title: string;
  readonly detail: string;
  readonly running: boolean;
  /** When the clock would have started had it never paused, so the system can count on from it. */
  readonly countingFromMs: number;
  /** The clock as it stands, for a paused timer, which the system does not count. */
  readonly clock: string;
  /** The words beside the clock: "Running", "Paused", or how many more timers there are. */
  readonly status: string;
  /** Where a tap goes: this build's own link to the timers. */
  readonly link: string;
};

/** The labels the activity needs, in the person's language. */
export type TimerActivityLabels = {
  readonly noDescription: string;
  readonly noMatter: string;
  readonly running: string;
  readonly paused: string;
  readonly more: (count: number) => string;
};

const resumedAt = (timer: Timer): number =>
  timer.lastResumedAt === null || timer.lastResumedAt === undefined
    ? 0
    : Temporal.Instant.from(timer.lastResumedAt).epochMilliseconds;

const stateLabel = (labels: TimerActivityLabels, running: boolean) =>
  running ? labels.running : labels.paused;

/** The running timer resumed last, or with none running, the paused one with the most time. */
const followedTimer = (timers: readonly Timer[]): Timer | undefined => {
  let latestRunning: Timer | undefined;
  let longestPaused: Timer | undefined;
  for (const timer of timers) {
    if (timer.state === "running") {
      if (
        latestRunning === undefined ||
        resumedAt(timer) > resumedAt(latestRunning)
      ) {
        latestRunning = timer;
      }
    } else if (
      longestPaused === undefined ||
      timer.accumulatedSeconds > longestPaused.accumulatedSeconds
    ) {
      longestPaused = timer;
    }
  }
  return latestRunning ?? longestPaused;
};

/**
 * The timer the activity follows: the one running, the latest resumed when
 * more are, or with none running, the paused one with the most time on it.
 * Null when there are no timers, which ends the activity.
 */
export const timerActivityOf = ({
  clockOf,
  labels,
  link,
  matterNames,
  now,
  timers,
}: {
  readonly clockOf: (seconds: number) => string;
  readonly labels: TimerActivityLabels;
  readonly link: string;
  readonly matterNames: ReadonlyMap<string, string>;
  readonly now: number;
  readonly timers: readonly Timer[];
}): TimerActivityProps | null => {
  const followed = followedTimer(timers);
  if (followed === undefined) {
    return null;
  }
  const seconds = elapsedSeconds(followed, now);
  const others = timers.length - 1;
  const isRunning = followed.state === "running";
  const matterName =
    followed.matterId === null || followed.matterId === undefined
      ? undefined
      : matterNames.get(followed.matterId);
  const description =
    followed.description === null ||
    followed.description === undefined ||
    followed.description.trim() === ""
      ? undefined
      : followed.description;
  return {
    clock: clockOf(seconds),
    countingFromMs: now - seconds * 1000,
    detail: description === undefined ? "" : (matterName ?? labels.noMatter),
    link,
    running: isRunning,
    status: others > 0 ? labels.more(others) : stateLabel(labels, isRunning),
    timerId: followed.id,
    title: description ?? matterName ?? labels.noDescription,
  };
};
