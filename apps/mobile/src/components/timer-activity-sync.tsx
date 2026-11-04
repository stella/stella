import { useEffect, useState } from "react";

import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { addPushToStartTokenListener } from "expo-widgets";
import type { LiveActivity } from "expo-widgets";
import { AppState } from "react-native";
import { useLocale, useTranslations } from "use-intl";
import * as v from "valibot";

import { MOBILE_APP_BUNDLE_IDS } from "@stll/api-contract/mobile-push";
import { timerActivityOf } from "@stll/api-contract/timer-activity";
import type {
  TimerActivityLabels,
  TimerActivityProps,
} from "@stll/api-contract/timer-activity";

import { useRevision } from "@/components/changes";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { APP_VARIANT } from "@/env";
import {
  isSignedOut,
  onTimerActivityDetailsChange,
  readTimerActivityDetails,
  TIMER_ACTIVITY_PUSH,
  timerActivityDeviceId,
} from "@/native/timer-activity-device";
import { listMatters } from "@/state/matters";
import { registerTimerActivityDevice } from "@/state/timer-activity-devices";
import { listTimers } from "@/state/timers";
import { TimerActivity } from "@/widgets/timer-activity";

/** The token that lets the server start an activity here, once iOS hands it over. */
let startToken: string | null = null;
/** The activity token the server last heard, so a repeated token reports nothing. */
let reportedActivityToken: string | null = null;
/** The number of the registration last sent. */
let sequence = 0;

/**
 * One activity at most: started, updated or ended to match `props`. Answers
 * the activity shown afterwards.
 */
const showTimerActivity = async (
  props: TimerActivityProps | null,
): Promise<LiveActivity<TimerActivityProps> | null> => {
  if (TimerActivity === null) {
    return null;
  }
  const [shown, ...extra] = TimerActivity.getInstances();
  await Promise.all(
    extra.map(async (activity) => await activity.end("immediate")),
  );
  if (props === null) {
    await shown?.end("immediate");
    return null;
  }
  if (shown === undefined) {
    return TimerActivity.start(props, props.link);
  }
  await shown.update(props);
  return shown;
};

const bundleIdSchema = v.picklist(MOBILE_APP_BUNDLE_IDS);

/**
 * Tells the server what this phone holds now, so a timer changed on another
 * device reaches its Lock Screen. Best effort: the next refresh sends it
 * again.
 */
const reportTimerActivity = async ({
  activity,
  link,
  locale,
  source,
}: {
  activity: LiveActivity<TimerActivityProps> | null;
  link: string;
  locale: string;
  source: AccessTokenSource;
}) => {
  const session = source.session();
  const bundleId = v.safeParse(
    bundleIdSchema,
    Constants.expoConfig?.ios?.bundleIdentifier,
  );
  if (session === undefined || !bundleId.success) {
    return;
  }
  const activityToken =
    (await activity?.getPushToken().catch(() => null)) ?? null;
  const deviceId = await timerActivityDeviceId(session).catch(() => null);
  const details = await readTimerActivityDetails(session).catch(() => null);
  // Signed out while this was prepared: the server would refuse it anyway,
  // once the sign-out reached it.
  if (deviceId === null || details === null || isSignedOut(session)) {
    return;
  }
  reportedActivityToken = activityToken;
  // Numbered by time, never twice the same, so the server files only the
  // newest when two cross on the way.
  sequence = Math.max(sequence + 1, epochMilliseconds());
  (
    await registerTimerActivityDevice({
      deviceId,
      fetch,
      registration: {
        activity:
          activity === null || activityToken === null
            ? null
            : { id: activity.getId(), token: activityToken },
        bundleId: bundleId.output,
        details,
        environment: APP_VARIANT === "development" ? "sandbox" : "production",
        link,
        locale,
        sequence,
        startToken,
      },
      source,
    })
  ).unwrapOr(undefined);
};

/**
 * Reads the timers once, when mounted, shows them in the activity and
 * reports the phone to the server. The sync mounts it afresh for each
 * refresh.
 */
const TimerActivityRefresh = ({
  onToken,
  source,
}: {
  onToken: () => void;
  source: AccessTokenSource;
}) => {
  const words = useTranslations("timerActivity");
  const locale = useLocale();

  useEffect(() => {
    // Unmounting aborts, so a refresh that outlives it changes nothing.
    const unmounted = new AbortController();
    // Read afresh after each await: a property read once would narrow to
    // the value it had before the await, though unmounting can change it.
    const gone = () => unmounted.signal.aborted;
    let tokenSubscription: { remove: () => void } | undefined;
    void (async () => {
      const timers = await listTimers({ fetch, source });
      // Time tracking off, or offline: the activity stays as it was.
      if (gone() || timers.isErr()) {
        return;
      }
      const named = timers.value.some(
        (timer) => timer.matterId !== null && timer.matterId !== undefined,
      );
      const matters = named ? await listMatters({ fetch, source }) : null;
      if (gone()) {
        return;
      }
      const labels: TimerActivityLabels = {
        more: (count) => words("more", { count }),
        noDescription: words("noDescription"),
        noMatter: words("noMatter"),
        paused: words("paused"),
        running: words("running"),
        timer: words("timer"),
      };
      const link = Linking.createURL("/timers");
      const activity = await showTimerActivity(
        timerActivityOf({
          details: "shown",
          labels,
          link,
          matterNames: new Map(
            matters?.isOk() === true
              ? matters.value.map((matter) => [matter.id, matter.name])
              : [],
          ),
          now: epochMilliseconds(),
          timers: timers.value,
        }),
      );
      if (gone() || !TIMER_ACTIVITY_PUSH) {
        return;
      }
      // iOS may hand the activity a new token at any time; the next
      // refresh reports it.
      tokenSubscription = activity?.addPushTokenListener(({ pushToken }) => {
        if (pushToken !== reportedActivityToken) {
          onToken();
        }
      });
      await reportTimerActivity({ activity, link, locale, source });
    })();
    return () => {
      unmounted.abort();
      tokenSubscription?.remove();
    };
  }, [locale, onToken, source, words]);

  return null;
};

/**
 * Keeps the timer's Live Activity in step with the person's timers: after
 * the app changes one, and whenever the app comes back to the front. It
 * starts the activity when a timer appears, updates it as one pauses or
 * resumes, and ends it when the last is saved or discarded, or the person
 * signs out. It also tells the server how to reach the activity, so a
 * change made on the web or the desktop updates it too. Renders nothing; a
 * build without Live Activities skips it all.
 */
export const TimerActivitySync = () => {
  const { state } = useSession();
  const revision = useRevision("timers");
  const [returns, setReturns] = useState(0);
  const [refresh] = useState(() => () => {
    setReturns((count) => count + 1);
  });
  const source = state.status === "signed-in" ? state.source : null;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        refresh();
      }
    });
    const stopDetails = onTimerActivityDetailsChange(refresh);
    const startTokens =
      TimerActivity !== null && TIMER_ACTIVITY_PUSH
        ? addPushToStartTokenListener(({ activityPushToStartToken }) => {
            if (activityPushToStartToken !== startToken) {
              startToken = activityPushToStartToken;
              refresh();
            }
          })
        : undefined;
    return () => {
      subscription.remove();
      stopDetails();
      startTokens?.remove();
    };
  }, [refresh]);

  useEffect(() => {
    if (source === null) {
      void showTimerActivity(null);
    }
  }, [source]);

  return TimerActivity === null || source === null ? null : (
    <TimerActivityRefresh
      key={`${revision}:${returns}`}
      onToken={refresh}
      source={source}
    />
  );
};
