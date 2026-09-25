import { shouldEnablePostHog } from "@stll/analytics-config";

import { envBase } from "@/api/env-base";

import { createPostHogAnalytics } from "./posthog-node";
import type { Analytics } from "./server-analytics";

const noop = () => undefined;
const asyncNoop = async () => await Promise.resolve();

// What the server sends when no PostHog project is configured: nothing.
const noopAnalytics: Analytics = {
  capture: noop,
  identifyOrganizationGroup: noop,
  flush: asyncNoop,
};

let analytics: Analytics | null = null;

export const isLocalPostHogDebugEnabled = (): boolean =>
  envBase.isDev && envBase.POSTHOG_LOCAL_DEBUG;

export const getAnalytics = (): Analytics => {
  if (analytics) {
    return analytics;
  }

  const posthogConfig = {
    isDev: envBase.isDev,
    key: envBase.POSTHOG_KEY,
    host: envBase.POSTHOG_HOST,
    localDebug: envBase.POSTHOG_LOCAL_DEBUG,
  };
  analytics = shouldEnablePostHog(posthogConfig)
    ? createPostHogAnalytics(posthogConfig.key, posthogConfig.host)
    : noopAnalytics;

  return analytics;
};

/**
 * Test seam: hand every caller of `getAnalytics()` this implementation, so a
 * test records what the real capture path emits (event, fingerprint,
 * throttling) instead of replacing the module that emits it.
 */
export const setAnalyticsForTesting = (replacement: Analytics): void => {
  analytics = replacement;
};

export const resetAnalyticsForTesting = (): void => {
  analytics = null;
};
