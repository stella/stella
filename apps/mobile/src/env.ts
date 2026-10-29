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

/** A build may name its server; otherwise the person types it at sign-in. */
export const PREFILLED_SERVER_URL: string =
  process.env.EXPO_PUBLIC_STELLA_SERVER_URL ?? "";

/**
 * Which build this is (`app.config.ts`), which decides its redirect. A build
 * without one is broken, so it stops at launch rather than signing in on
 * another build's redirect.
 */
export const APP_VARIANT: MobileAppVariant = v.parse(
  v.object({ variant: v.picklist(MOBILE_APP_VARIANTS) }),
  Constants.expoConfig?.extra,
).variant;
