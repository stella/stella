import {
  TIMER_ACTIVITY_ATTRIBUTES_TYPE,
  TIMER_ACTIVITY_NAME,
  timerActivityOf,
} from "@stll/api-contract/timer-activity";
import type {
  TimerActivityContentState,
  TimerActivityPushPayload,
  TimerActivityTimer,
} from "@stll/api-contract/timer-activity";
import { resolveUiLocale } from "@stll/locales";
import { timerActivityLabels } from "@stll/transactional/push/timer-activity-labels";

import type { TimerActivityDevice } from "@/api/lib/push/timer-activity-devices";

/** What one phone should be sent about the person's timers, if anything. */
export type TimerActivityPush =
  | { type: "none" }
  | { type: "update"; token: string; payload: TimerActivityPushPayload }
  | { type: "end"; token: string; payload: TimerActivityPushPayload }
  | { type: "start"; token: string; payload: TimerActivityPushPayload };

const seconds = (ms: number) => Math.floor(ms / 1000);

/**
 * The push that brings one phone's Lock Screen in step with the person's
 * timers as they stand at `now`.
 *
 * - a phone showing an activity is sent the activity as it should look, or
 *   its end when no timer is left;
 * - a phone showing none, with a running timer, is sent the start of one,
 *   once, until the app reports it (iOS 17.2 and later hand out the token
 *   for that);
 * - otherwise nothing.
 *
 * A phone whose person turned details off is sent neither the timer's
 * description nor its matter; the alert that announces a start names
 * nothing either way. The timestamp lets iOS drop an update older than the
 * one it shows.
 */
export const timerActivityPushFor = ({
  device,
  matterNames,
  now,
  timers,
}: {
  device: Pick<
    TimerActivityDevice,
    "locale" | "link" | "details" | "startToken" | "activityToken" | "startedAt"
  >;
  matterNames: ReadonlyMap<string, string>;
  now: number;
  timers: readonly TimerActivityTimer[];
}): TimerActivityPush => {
  const labels = timerActivityLabels(resolveUiLocale(device.locale) ?? "en");
  const props = timerActivityOf({
    details: device.details ? "shown" : "hidden",
    labels,
    link: device.link,
    matterNames,
    now,
    timers,
  });
  const timestamp = seconds(now);
  const contentState = (
    state: NonNullable<typeof props>,
  ): TimerActivityContentState => ({
    name: TIMER_ACTIVITY_NAME,
    props: JSON.stringify(state),
  });

  if (device.activityToken !== null) {
    if (props === null) {
      return {
        type: "end",
        token: device.activityToken,
        payload: {
          aps: {
            timestamp,
            event: "end",
            "content-state": contentState({
              clock: "",
              countingFromMs: now,
              detail: "",
              link: device.link,
              running: false,
              status: labels.paused,
              timerId: "",
              title: labels.timer,
            }),
            "dismissal-date": timestamp,
          },
        },
      };
    }
    return {
      type: "update",
      token: device.activityToken,
      payload: {
        aps: {
          timestamp,
          event: "update",
          "content-state": contentState(props),
        },
      },
    };
  }
  if (
    props?.running === true &&
    device.startToken !== null &&
    device.startedAt === null
  ) {
    return {
      type: "start",
      token: device.startToken,
      payload: {
        aps: {
          timestamp,
          event: "start",
          "content-state": contentState(props),
          "attributes-type": TIMER_ACTIVITY_ATTRIBUTES_TYPE,
          attributes: { url: device.link },
          alert: { title: labels.timer, body: labels.startedElsewhere },
        },
      },
    };
  }
  return { type: "none" };
};
