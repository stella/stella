// The running timer on an iPhone's Lock Screen and in its Dynamic Island: what
// it shows, built the same way by the app (after a change it made) and by the
// server (after a change made on another device), and how the app registers
// the phone so the server can reach it.
//
// A server update travels through Apple's push service and replaces all the
// activity shows, so a phone whose person turned details off is sent only the
// clock and whether it runs: its description and matter stay in stella.

import * as v from "valibot";

import { Temporal } from "@stll/time";

import { truncateEntityName } from "./entity-options";
import {
  APNS_ENVIRONMENTS,
  MOBILE_APP_BUNDLE_IDS,
  pushDeviceTokenSchema,
} from "./mobile-push";

/** The activity's name: the app's widget extension draws it under this one. */
export const TIMER_ACTIVITY_NAME = "TimerActivity";

/**
 * The ActivityKit attributes type of the app's widget extension, which a
 * push that starts an activity must name.
 */
export const TIMER_ACTIVITY_ATTRIBUTES_TYPE = "LiveActivityAttributes";

/** The parts of a timer the activity reads, as the timers API answers them. */
export type TimerActivityTimer = {
  readonly id: string;
  readonly matterId?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly state: "running" | "paused";
  /** Seconds counted before the timer last resumed. */
  readonly accumulatedSeconds: number;
  /** When a running timer last started counting; null while paused. */
  readonly lastResumedAt?: string | null | undefined;
};

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
  /** Where a tap goes: the build's own link to the timers. */
  readonly link: string;
  /** Whether this phone holds a key its Lock Screen buttons can act with. */
  readonly actions: boolean;
  /** The button's word: pause a running timer, resume a paused one. */
  readonly actionLabel: string;
  /** What the button does, as the app's native side reads it. */
  readonly actionTarget: string;
};

/** What a Lock Screen button does to the timer it shows. */
export const TIMER_ACTIVITY_ACTIONS = ["pause", "resume"] as const;
export type TimerActivityAction = (typeof TIMER_ACTIVITY_ACTIONS)[number];

const ACTION_TARGET_PREFIX = "stella-timer";

/**
 * The name a Lock Screen button carries to the app's native side, which
 * reads the action and the timer from it: `stella-timer:pause:<timer id>`.
 */
export const timerActivityActionTarget = (
  action: TimerActivityAction,
  timerId: string,
): string => `${ACTION_TARGET_PREFIX}:${action}:${timerId}`;

/** The labels the activity needs, in the person's language. */
export type TimerActivityLabels = {
  /** The title of a timer whose details are not sent. */
  readonly timer: string;
  readonly noDescription: string;
  readonly noMatter: string;
  readonly running: string;
  readonly paused: string;
  readonly pause: string;
  readonly resume: string;
  readonly more: (count: number) => string;
};

/**
 * Whether the activity names what is timed. `hidden` is for an update that
 * travels through Apple to a phone whose person turned details off.
 */
export type TimerActivityDetails = "shown" | "hidden";

/** Seconds as a clock: 0:05:09, or 12:30:00. */
export const clockOf = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const rest = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
};

const resumedAtMs = (timer: TimerActivityTimer): number | null =>
  timer.lastResumedAt === null || timer.lastResumedAt === undefined
    ? null
    : Temporal.Instant.from(timer.lastResumedAt).epochMilliseconds;

/** The seconds a timer has counted by `now`, in epoch milliseconds. */
export const elapsedSeconds = (
  timer: TimerActivityTimer,
  now: number,
): number => {
  const resumedAt = resumedAtMs(timer);
  if (timer.state !== "running" || resumedAt === null) {
    return timer.accumulatedSeconds;
  }
  const since = Math.floor((now - resumedAt) / 1000);
  return timer.accumulatedSeconds + Math.max(0, since);
};

/** The running timer resumed last, or with none running, the paused one with the most time. */
const followedTimer = <T extends TimerActivityTimer>(
  timers: readonly T[],
): T | undefined => {
  let latestRunning: T | undefined;
  let longestPaused: T | undefined;
  for (const timer of timers) {
    if (timer.state === "running") {
      if (
        latestRunning === undefined ||
        (resumedAtMs(timer) ?? 0) > (resumedAtMs(latestRunning) ?? 0)
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
 * The most of a description or matter name the activity shows. The Lock
 * Screen shows a line of each, and Apple refuses an activity whose data is
 * past 4 KB, which a 10,000-character description would be.
 */
export const TIMER_ACTIVITY_TEXT_MAX_LENGTH = 120;

const shortened = (text: string): string =>
  text.length <= TIMER_ACTIVITY_TEXT_MAX_LENGTH
    ? text
    : `${truncateEntityName(text, TIMER_ACTIVITY_TEXT_MAX_LENGTH - 1).trimEnd()}…`;

const named = (text: string | null | undefined): string | undefined =>
  text === null || text === undefined || text.trim() === ""
    ? undefined
    : shortened(text.trim());

/**
 * The timer the activity follows: the one running, the latest resumed when
 * more are, or with none running, the paused one with the most time on it.
 * Null when there are no timers, which ends the activity.
 */
export const timerActivityOf = ({
  actions,
  details,
  labels,
  link,
  matterNames,
  now,
  timers,
}: {
  /** Whether the phone holds a key its Lock Screen buttons can act with. */
  readonly actions: boolean;
  readonly details: TimerActivityDetails;
  readonly labels: TimerActivityLabels;
  readonly link: string;
  readonly matterNames: ReadonlyMap<string, string>;
  readonly now: number;
  readonly timers: readonly TimerActivityTimer[];
}): TimerActivityProps | null => {
  const followed = followedTimer(timers);
  if (followed === undefined) {
    return null;
  }
  const seconds = elapsedSeconds(followed, now);
  const others = timers.length - 1;
  const isRunning = followed.state === "running";
  const state = isRunning ? labels.running : labels.paused;
  const shared = {
    actionLabel: isRunning ? labels.pause : labels.resume,
    actionTarget: timerActivityActionTarget(
      isRunning ? "pause" : "resume",
      followed.id,
    ),
    actions,
    clock: clockOf(seconds),
    countingFromMs: now - seconds * 1000,
    link,
    running: isRunning,
    timerId: followed.id,
  };
  // Hidden details say nothing of the other timers either: only the clock
  // and whether it runs.
  if (details === "hidden") {
    return { ...shared, detail: "", status: state, title: labels.timer };
  }
  const status = others > 0 ? labels.more(others) : state;
  const matterName = named(
    followed.matterId === null || followed.matterId === undefined
      ? undefined
      : matterNames.get(followed.matterId),
  );
  const description = named(followed.description);
  return {
    ...shared,
    detail: description === undefined ? "" : (matterName ?? labels.noMatter),
    status,
    title: description ?? matterName ?? labels.noDescription,
  };
};

const TIMER_ACTIVITY_LINK_MAX_LENGTH = 200;
const TIMER_ACTIVITY_ID_MAX_LENGTH = 128;

/**
 * `PUT /v1/me/timer-activity-devices/:deviceId`: what this phone holds now.
 * The app sends its whole state each time, numbered, so a registration that
 * arrives after a newer one, or after the sign-out, changes nothing.
 */
export const timerActivityDeviceRegistrationSchema = v.strictObject({
  /** Grows with each registration from this sign-in; the server keeps only a newer one. */
  sequence: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  environment: v.picklist(APNS_ENVIRONMENTS),
  bundleId: v.picklist(MOBILE_APP_BUNDLE_IDS),
  /** The app's language as a BCP 47 tag; the activity's words are chosen from it. */
  locale: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(2),
    v.maxLength(35),
    v.regex(
      /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/u,
      "Expected a BCP 47 language tag.",
    ),
  ),
  /** The build's own link to its timers, which a tap on the activity opens. */
  link: v.pipe(
    v.string(),
    v.maxLength(TIMER_ACTIVITY_LINK_MAX_LENGTH),
    v.regex(
      /^app\.stll(?:\.dev|\.preview)?:\/\/\/?(?:expo-development-client\/)?timers$/u,
      "Expected the app's own link to its timers.",
    ),
  ),
  /** Whether updates sent through Apple may name the timer's description and matter. */
  details: v.boolean(),
  /** Whether the phone wants a new key for its Lock Screen buttons. */
  actionKey: v.boolean(),
  /** The token that starts an activity on this phone (iOS 17.2 and later). */
  startToken: v.nullable(pushDeviceTokenSchema),
  /** The activity the phone shows now and the token that updates it. */
  activity: v.nullable(
    v.strictObject({
      id: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(TIMER_ACTIVITY_ID_MAX_LENGTH),
      ),
      token: pushDeviceTokenSchema,
    }),
  ),
});

export type TimerActivityDeviceRegistration = v.InferOutput<
  typeof timerActivityDeviceRegistrationSchema
>;

export const timerActivityDeviceParamsSchema = v.object({
  deviceId: v.pipe(v.string(), v.uuid()),
});

/** How many phones one person may keep registered; the oldest go first. */
export const TIMER_ACTIVITY_DEVICES_PER_USER_MAX = 10;

/**
 * How long a Lock Screen button key works. The phone asks for a new one well
 * before then, each time it registers; sign-out ends it at once.
 */
export const TIMER_ACTIVITY_ACTION_KEY_HOURS = 12;

/** A key the phone's Lock Screen buttons act with, shown once. */
export type TimerActivityActionKey = {
  /** `<user id>.<64 hex>`: only the hex part's SHA-256 is kept. */
  key: string;
  expiresAt: string;
};

/** What a registration answers once the phone is filed. */
export type TimerActivityDeviceRegistrationResponse = {
  registered: true;
  /** The new key, when the registration asked for one and the sign-in still lasts. */
  actionKey: TimerActivityActionKey | null;
};

/**
 * `POST /v1/me/timer-activity-devices/:deviceId/actions`, sent by the
 * phone's native side for a Lock Screen button, with the key as its bearer
 * credential instead of a session.
 */
export const timerActivityActionSchema = v.strictObject({
  timerId: v.pipe(v.string(), v.uuid()),
  action: v.picklist(TIMER_ACTIVITY_ACTIONS),
});

export type TimerActivityActionRequest = v.InferOutput<
  typeof timerActivityActionSchema
>;

/** `DELETE`: removing a phone that was not registered succeeds with `removed: false`. */
export type TimerActivityDeviceRemovalResponse = { removed: boolean };

/** The ActivityKit content state: the activity's name and its props as JSON. */
export type TimerActivityContentState = {
  name: typeof TIMER_ACTIVITY_NAME;
  props: string;
};

/** An APNs `liveactivity` payload for the timer's activity. */
export type TimerActivityPushPayload = {
  aps:
    | {
        timestamp: number;
        event: "update";
        "content-state": TimerActivityContentState;
        "stale-date"?: number;
      }
    | {
        timestamp: number;
        event: "end";
        "content-state": TimerActivityContentState;
        "dismissal-date": number;
      }
    | {
        timestamp: number;
        event: "start";
        "content-state": TimerActivityContentState;
        "attributes-type": typeof TIMER_ACTIVITY_ATTRIBUTES_TYPE;
        attributes: { url: string };
        alert: { title: string; body: string };
      };
};
