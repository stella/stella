import Constants from "expo-constants";
import * as Notifications from "expo-notifications";

import { APP_VARIANT, PUSH_NOTIFICATIONS } from "@/env";
import type { PushDevice } from "@/state/push-devices";

// A notification that arrives while the app is open still shows, as a banner.
if (PUSH_NOTIFICATIONS) {
  Notifications.setNotificationHandler({
    handleNotification: async () =>
      await Promise.resolve({
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
  });
}

/**
 * This phone as the server should know it, asking the person's leave the
 * first time when `ask` says so; null without their leave or a token.
 */
export const currentPushDevice = async ({
  ask,
  locale,
}: {
  /** Whether to ask the person when they have not been asked yet. */
  readonly ask: boolean;
  readonly locale: string;
}): Promise<PushDevice | null> => {
  let settings = await Notifications.getPermissionsAsync();
  if (ask && !settings.granted && settings.canAskAgain) {
    settings = await Notifications.requestPermissionsAsync();
  }
  if (!settings.granted) {
    return null;
  }
  const token = await Notifications.getDevicePushTokenAsync();
  return typeof token.data === "string"
    ? {
        apsEnvironment:
          APP_VARIANT === "development" ? "sandbox" : "production",
        appVersion: Constants.expoConfig?.version ?? "0",
        bundleId: Constants.expoConfig?.ios?.bundleIdentifier ?? "",
        locale,
        token: token.data,
      }
    : null;
};
