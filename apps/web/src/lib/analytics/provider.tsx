import { createContext, use, useLayoutEffect, useRef } from "react";
import type { PropsWithChildren } from "react";

import { PostHogProvider } from "@posthog/react";

import { env } from "@/env";
import { hasPostHogConfig } from "@/lib/analytics/config";
import { noopAnalytics } from "@/lib/analytics/noop";
import { createPostHogAnalytics } from "@/lib/analytics/posthog";
import type { Analytics } from "@/lib/analytics/types";

const AnalyticsContext = createContext<Analytics>(noopAnalytics);
let globalAnalytics: Analytics = noopAnalytics;

export const useAnalytics = () => use(AnalyticsContext);
export const getAnalytics = () => globalAnalytics;

/**
 * Wraps the app with the configured analytics provider.
 *
 * When PostHog env vars are set, initializes PostHog and
 * wraps children in PostHogProvider (for session recording,
 * heatmaps). When absent, provides a silent no-op.
 */
type AnalyticsValue = {
  analytics: Analytics;
  client: ReturnType<typeof createPostHogAnalytics>["client"] | null;
};

export const AnalyticsProvider = ({ children }: PropsWithChildren) => {
  const valueRef = useRef<AnalyticsValue | null>(null);
  const posthogConfig = {
    host: env.VITE_POSTHOG_HOST,
    key: env.VITE_POSTHOG_KEY,
  };
  if (valueRef.current === null) {
    const shouldEnablePostHog =
      hasPostHogConfig(posthogConfig) &&
      (!import.meta.env.DEV || env.VITE_POSTHOG_LOCAL_DEBUG);

    valueRef.current = shouldEnablePostHog
      ? createPostHogAnalytics(posthogConfig.key, posthogConfig.host)
      : { analytics: noopAnalytics, client: null };
  }
  const value = valueRef.current;

  useLayoutEffect(() => {
    globalAnalytics = value.analytics;

    return () => {
      if (globalAnalytics === value.analytics) {
        globalAnalytics = noopAnalytics;
      }
    };
  }, [value.analytics]);

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
