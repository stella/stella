import { useEffect, useState } from "react";

import * as Linking from "expo-linking";
import { AppState } from "react-native";
import { useTranslations } from "use-intl";

import { useRevision } from "@/components/changes";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { listMatters } from "@/state/matters";
import { timerActivityOf } from "@/state/timer-activity";
import type { TimerActivityProps } from "@/state/timer-activity";
import { clockOf, listTimers } from "@/state/timers";
import { TimerActivity } from "@/widgets/timer-activity";

/** One activity at most: started, updated or ended to match `props`. */
const showTimerActivity = async (props: TimerActivityProps | null) => {
  if (TimerActivity === null) {
    return;
  }
  const [shown, ...extra] = TimerActivity.getInstances();
  await Promise.all(
    extra.map(async (activity) => await activity.end("immediate")),
  );
  if (props === null) {
    await shown?.end("immediate");
  } else if (shown === undefined) {
    TimerActivity.start(props, props.link);
  } else {
    await shown.update(props);
  }
};

/**
 * Reads the timers once, when mounted, and shows them in the activity. The
 * sync mounts it afresh for each refresh.
 */
const TimerActivityRefresh = ({ source }: { source: AccessTokenSource }) => {
  const t = useTranslations("timers");

  useEffect(() => {
    let current = true;
    void (async () => {
      const timers = await listTimers({ fetch, source });
      // Time tracking off, or offline: the activity stays as it was.
      if (!current || timers.isErr()) {
        return;
      }
      const named = timers.value.some(
        (timer) => timer.matterId !== null && timer.matterId !== undefined,
      );
      const matters = named ? await listMatters({ fetch, source }) : null;
      if (!current) {
        return;
      }
      await showTimerActivity(
        timerActivityOf({
          clockOf,
          labels: {
            more: (count) => t("more", { count }),
            noDescription: t("noDescription"),
            noMatter: t("noMatter"),
            paused: t("paused"),
            running: t("running"),
          },
          link: Linking.createURL("/timers"),
          matterNames: new Map(
            matters?.isOk() === true
              ? matters.value.map((matter) => [matter.id, matter.name])
              : [],
          ),
          now: epochMilliseconds(),
          timers: timers.value,
        }),
      );
    })();
    return () => {
      current = false;
    };
  }, [source, t]);

  return null;
};

/**
 * Keeps the timer's Live Activity in step with the person's timers: after
 * the app changes one, and whenever the app comes back to the front, as a
 * timer may have changed on the web meanwhile. It starts the activity when a
 * timer appears, updates it as one pauses or resumes, and ends it when the
 * last is saved or discarded, or the person signs out. Renders nothing; a
 * build without Live Activities skips it all.
 */
export const TimerActivitySync = () => {
  const { state } = useSession();
  const revision = useRevision("timers");
  const [returns, setReturns] = useState(0);
  const source = state.status === "signed-in" ? state.source : null;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        setReturns((count) => count + 1);
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (source === null) {
      void showTimerActivity(null);
    }
  }, [source]);

  return TimerActivity === null || source === null ? null : (
    <TimerActivityRefresh key={`${revision}:${returns}`} source={source} />
  );
};
