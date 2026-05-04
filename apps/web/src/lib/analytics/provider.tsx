import { createContext, use, useState } from "react";
import type { PropsWithChildren } from "react";

import { PostHogProvider } from "@posthog/react";

import { env } from "@/env";
import { hasPostHogConfig } from "@/lib/analytics/config";
import { noopAnalytics } from "@/lib/analytics/noop";
import { createPostHogAnalytics } from "@/lib/analytics/posthog";
import type { Analytics } from "@/lib/analytics/types";

const AnalyticsContext = createContext(noopAnalytics);
let globalAnalytics: Analytics = noopAnalytics;

export const useAnalytics = () => use(AnalyticsContext);
export const getAnalytics = () => globalAnalytics;

/**
 * Wraps the app with the configured analytics provider.
 *
 * When PostHog env vars are explicitly set, initializes PostHog for
 * allowlisted telemetry. Missing env vars provide a silent no-op, so
 * self-hosted deployments do not phone home unless their operator
 * configures their own telemetry sink.
 */
export type AnalyticsValue = {
  analytics: Analytics;
  client: ReturnType<typeof createPostHogAnalytics>["client"] | null;
};

export const createAnalyticsValue = (): AnalyticsValue => {
  const posthogConfig = {
    host: env.VITE_POSTHOG_HOST,
    key: env.VITE_POSTHOG_KEY,
  };
  const shouldEnablePostHog =
    hasPostHogConfig(posthogConfig) &&
    (!import.meta.env.DEV || env.VITE_POSTHOG_LOCAL_DEBUG);
  const value = shouldEnablePostHog
    ? createPostHogAnalytics(posthogConfig.key, posthogConfig.host)
    : { analytics: noopAnalytics, client: null };

  globalAnalytics = value.analytics;

  return value;
};

type AnalyticsProviderProps = PropsWithChildren<{
  value: AnalyticsValue;
}>;

export const AnalyticsProvider = ({
  children,
  value: providedValue,
}: AnalyticsProviderProps) => {
  const [value] = useState(() => providedValue);

  if (value.client) {
    return (
      <PostHogProvider client={value.client}>
        <AnalyticsContext value={value.analytics}>{children}</AnalyticsContext>
      </PostHogProvider>
    );
  }

  return (
    <AnalyticsContext value={value.analytics}>{children}</AnalyticsContext>
  );
};
