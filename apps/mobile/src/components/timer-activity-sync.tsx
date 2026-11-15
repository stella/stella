import { useEffect, useState } from "react";

import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { addPushToStartTokenListener } from "expo-widgets";
import type { LiveActivity } from "expo-widgets";
import { AppState } from "react-native";
import { Temporal } from "temporal-polyfill/full";
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
  keepTimerActionKey,
  nextTimerActivitySequence,
  onTimerActivityDetailsChange,
  readTimerActivityDetails,
  TIMER_ACTIVITY_PUSH,
  timerActionKeyHeld,
  timerActionKeyRenewalIn,
  timerActionsLive,
  timerActivityDeviceId,
  wantsTimerActionKey,
} from "@/native/timer-activity-device";
import { listMatters } from "@/state/matters";
import { registerTimerActivityDevice } from "@/state/timer-activity-devices";
import { listTimers } from "@/state/timers";
import { TimerActivity } from "@/widgets/timer-activity";

/** The token that lets the server start an activity here, once iOS hands it over. */
let startToken: string | null = null;
/** The activity token the server last heard, so a repeated token reports nothing. */
let reportedActivityToken: string | null = null;

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

/** The longest a timer may wait; longer ones fire at once on some engines. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The soonest a renewal is tried again: a renewal that did not take (offline,
 * no key issued, a newer one kept) waits this long rather than looping.
 */
const RENEWAL_RETRY_MS = 10 * 60 * 1000;

/**
 * Tells the server what this phone holds now, so a timer changed on another
 * device reaches its Lock Screen, asking for a new Lock Screen button key
 * when the one held runs low. Best effort: the next refresh sends it again.
 * Answers whether it kept a newly issued key.
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
}): Promise<boolean> => {
  const session = source.session();
  const bundleId = v.safeParse(
    bundleIdSchema,
    Constants.expoConfig?.ios?.bundleIdentifier,
  );
  if (session === undefined || !bundleId.success) {
    return false;
  }
  const activityToken =
    (await activity?.getPushToken().catch(() => null)) ?? null;
  const deviceId = await timerActivityDeviceId(session).catch(() => null);
  const details = await readTimerActivityDetails(session).catch(() => null);
  // Signed out while this was prepared: the server would refuse it anyway,
  // once the sign-out reached it.
  if (deviceId === null || details === null || isSignedOut(session)) {
    return false;
  }
  const actionKey = await wantsTimerActionKey(
    session,
    epochMilliseconds(),
  ).catch(() => false);
  const actionKeyHeld = await timerActionKeyHeld(
    session,
    epochMilliseconds(),
  ).catch(() => false);
  // Numbered, never twice the same, so the server files only the newest
  // when two cross on the way.
  const sequence = await nextTimerActivitySequence(
    session,
    epochMilliseconds(),
  ).catch(() => null);
  if (sequence === null) {
    return false;
  }
  reportedActivityToken = activityToken;
  const issued = (
    await registerTimerActivityDevice({
      deviceId,
      fetch,
      registration: {
        activity:
          activity === null || activityToken === null
            ? null
            : { id: activity.getId(), token: activityToken },
        actionKey,
        actionKeyHeld,
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
  ).unwrapOr(null);
  // A key that arrives after the sign-out is not kept: the sign-out has
  // already taken the buttons back.
  if (issued === null || isSignedOut(session)) {
    return false;
  }
  const kept = await keepTimerActionKey({
    deviceId,
    expiresAt: Temporal.Instant.from(issued.expiresAt).epochMilliseconds,
    key: issued.key,
    sequence,
    session,
  }).catch(() => "unconfigured" as const);
  return kept === "kept";
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
    let renewal: ReturnType<typeof setTimeout> | undefined;
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
        pause: words("pause"),
        paused: words("paused"),
        resume: words("resume"),
        running: words("running"),
        timer: words("timer"),
      };
      const link = Linking.createURL("/timers");
      const session = source.session();
      const actions =
        session !== undefined &&
        (await timerActionsLive(session, epochMilliseconds()).catch(
          () => false,
        ));
      if (gone()) {
        return;
      }
      const props = timerActivityOf({
        actions,
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
      });
      const activity = await showTimerActivity(props);
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
      const keptKey = await reportTimerActivity({
        activity,
        link,
        locale,
        source,
      });
      if (gone()) {
        return;
      }
      // A new key: refresh at once, which reads the timers afresh, shows
      // the buttons, and tells the server the phone holds the key.
      if (keptKey) {
        onToken();
        return;
      }
      // While the app stays open, renew the key before it runs low.
      const renewIn =
        session === undefined
          ? null
          : await timerActionKeyRenewalIn(session, epochMilliseconds()).catch(
              () => null,
            );
      if (renewIn !== null && !gone()) {
        renewal = setTimeout(
          onToken,
          Math.min(Math.max(renewIn, RENEWAL_RETRY_MS), MAX_TIMEOUT_MS),
        );
      }
    })();
    return () => {
      unmounted.abort();
      tokenSubscription?.remove();
      clearTimeout(renewal);
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
