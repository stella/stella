import { env } from "@/api/env";

import { shouldEnablePostHog } from "./config";
import { noopAnalytics } from "./noop";
import { createPostHogAnalytics } from "./posthog";
import type { Analytics } from "./types";

let analytics: Analytics | null = null;

export const isLocalPostHogDebugEnabled = (): boolean =>
  env.isDev && env.POSTHOG_LOCAL_DEBUG;

export const getAnalytics = (): Analytics => {
  if (analytics) {
    return analytics;
  }

  const key = env.POSTHOG_KEY;
  const host = env.POSTHOG_HOST;
  analytics =
    shouldEnablePostHog({
      isDev: env.isDev,
      key,
      host,
      localDebug: env.POSTHOG_LOCAL_DEBUG,
    }) &&
    key &&
    host
      ? createPostHogAnalytics(key, host)
      : noopAnalytics;

  return analytics;
};
