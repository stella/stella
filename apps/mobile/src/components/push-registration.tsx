import { useEffect, useRef } from "react";

import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useLocale } from "use-intl";

import { useSession } from "@/connection/session-provider";
import { PUSH_NOTIFICATIONS } from "@/env";
import { currentPushDevice } from "@/native/push-device";
import { registerPushDevice } from "@/state/push-devices";
import { routeForPush } from "@/state/push-route";

/**
 * Signed in, registers this phone for the person's notifications, which
 * asks their leave the first time; and opens what a tapped notification
 * points at, from a cold start too. Renders nothing; a build without push
 * skips it all.
 */
export const PushRegistration = () => {
  const { state } = useSession();
  const locale = useLocale();
  const router = useRouter();
  const source = state.status === "signed-in" ? state.source : null;
  const response = Notifications.useLastNotificationResponse();
  const opened = useRef<string | null>(null);

  useEffect(() => {
    if (!PUSH_NOTIFICATIONS || source === null) {
      return;
    }
    void (async () => {
      const device = await currentPushDevice({ ask: true, locale }).catch(
        () => null,
      );
      if (device !== null) {
        // Best effort: the next launch registers again.
        (await registerPushDevice({ device, fetch, source })).unwrapOr(
          undefined,
        );
      }
    })();
  }, [locale, source]);

  useEffect(() => {
    const id = response?.notification.request.identifier;
    if (
      !PUSH_NOTIFICATIONS ||
      source === null ||
      response === undefined ||
      response === null ||
      id === undefined ||
      opened.current === id ||
      response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER
    ) {
      return;
    }
    opened.current = id;
    router.push(routeForPush(response.notification.request.content.data));
  }, [response, router, source]);

  return null;
};
