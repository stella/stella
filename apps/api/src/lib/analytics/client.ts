import { envBase } from "@/api/env-base";

import { shouldEnablePostHog } from "./config";
import { noopAnalytics } from "./noop";
import { createPostHogAnalytics } from "./posthog";
import type { Analytics } from "./types";

let analytics: Analytics | null = null;

export const isLocalPostHogDebugEnabled = (): boolean =>
  envBase.isDev && envBase.POSTHOG_LOCAL_DEBUG;

export const getAnalytics = (): Analytics => {
  if (analytics) {
    return analytics;
  }

  const key = envBase.POSTHOG_KEY;
  const host = envBase.POSTHOG_HOST;
  analytics =
    shouldEnablePostHog({
      isDev: envBase.isDev,
      key,
      host,
      localDebug: envBase.POSTHOG_LOCAL_DEBUG,
    }) &&
    key &&
    host
      ? createPostHogAnalytics(key, host)
      : noopAnalytics;

  return analytics;
};
