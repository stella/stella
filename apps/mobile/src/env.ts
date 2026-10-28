import Constants from "expo-constants";
import * as v from "valibot";

import {
  MOBILE_APP_VARIANTS,
  type MobileAppVariant,
} from "@stll/api-contract/mobile-client";

/**
 * The app's build-time configuration. Expo inlines `EXPO_PUBLIC_*` values
 * into the bundle at build time, and only when they are read with dot
 * access, so nothing here is a secret and nothing may be read dynamically.
 */

/** stella's own service, which every build signs in to unless told otherwise. */
export const STELLA_SERVER_URL = "https://api.stll.app";

/**
 * The server sign-in uses: stella's own, or the one a build names (a local
 * stack on a simulator). Another server is a sign-in option, never the ask.
 */
export const DEFAULT_SERVER_URL: string =
  process.env.EXPO_PUBLIC_STELLA_SERVER_URL ?? STELLA_SERVER_URL;

/**
 * Which build this is (`app.config.ts`), which decides its redirect. A build
 * without one is broken, so it stops at launch rather than signing in on
 * another build's redirect.
 */
const extra = v.parse(
  v.object({
    liveActivities: v.optional(v.boolean(), false),
    pushNotifications: v.optional(v.boolean(), false),
    variant: v.picklist(MOBILE_APP_VARIANTS),
  }),
  Constants.expoConfig?.extra,
);

export const APP_VARIANT: MobileAppVariant = extra.variant;

/**
 * Whether the build carries the widget extension that draws Live
 * Activities (`app.config.ts`); a release leaves it out until it signs it.
 */
export const LIVE_ACTIVITIES: boolean = extra.liveActivities;

/**
 * Whether the build may take push notifications (`app.config.ts`); a
 * release does once its profile carries the push capability.
 */
export const PUSH_NOTIFICATIONS: boolean = extra.pushNotifications;
