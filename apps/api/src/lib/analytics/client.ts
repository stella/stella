import { shouldEnablePostHog } from "@stll/analytics-config";

import { envBase } from "@/api/env-base";
import { isLocalDevOpen } from "@/api/runtime-mode";

import { createPostHogNodeAnalytics } from "./posthog-node";
import type { ServerAnalytics } from "./server-analytics";

const noop = () => undefined;
const asyncNoop = async () => await Promise.resolve();

// What the server sends when no PostHog project is configured: nothing.
const noopAnalytics: ServerAnalytics = {
  capture: noop,
  identifyOrganizationGroup: noop,
  flush: asyncNoop,
};

let analytics: ServerAnalytics | null = null;

export const isLocalPostHogDebugEnabled = (): boolean =>
  isLocalDevOpen() && envBase.POSTHOG_LOCAL_DEBUG;

export const getServerAnalytics = (): ServerAnalytics => {
  if (analytics) {
    return analytics;
  }

  const posthogConfig = {
    suppressTelemetry: isLocalDevOpen(),
    key: envBase.POSTHOG_KEY,
    host: envBase.POSTHOG_HOST,
    localDebug: envBase.POSTHOG_LOCAL_DEBUG,
  };
  analytics = shouldEnablePostHog(posthogConfig)
    ? createPostHogNodeAnalytics(posthogConfig.key, posthogConfig.host)
    : noopAnalytics;

  return analytics;
};

/**
 * Test seam: hand every caller of `getServerAnalytics()` this implementation, so a
 * test records what the real capture path emits (event, fingerprint,
 * throttling) instead of replacing the module that emits it.
 */
export const setAnalyticsForTesting = (replacement: ServerAnalytics): void => {
  analytics = replacement;
};

export const resetAnalyticsForTesting = (): void => {
  analytics = null;
};
