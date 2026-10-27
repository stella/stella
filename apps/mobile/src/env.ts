/**
 * The app's build-time configuration. Expo inlines `EXPO_PUBLIC_*` values
 * into the bundle at build time, and only when they are read with dot
 * access, so nothing here is a secret and nothing may be read dynamically.
 */

/** A build may name its server; otherwise the person types it at sign-in. */
export const PREFILLED_SERVER_URL: string =
  process.env.EXPO_PUBLIC_STELLA_SERVER_URL ?? "";
