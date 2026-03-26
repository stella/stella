import { createContext, use, useRef } from "react";
import type { PropsWithChildren } from "react";

import { PostHogProvider } from "@posthog/react";

import { env } from "@/env";
import { noopAnalytics } from "@/lib/analytics/noop";
import { createPostHogAnalytics } from "@/lib/analytics/posthog";
import type { Analytics } from "@/lib/analytics/types";

const AnalyticsContext = createContext<Analytics>(noopAnalytics);

export const useAnalytics = () => use(AnalyticsContext);

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
  valueRef.current ??=
    env.VITE_POSTHOG_KEY && env.VITE_POSTHOG_HOST
      ? createPostHogAnalytics(env.VITE_POSTHOG_KEY, env.VITE_POSTHOG_HOST)
      : { analytics: noopAnalytics, client: null };
  const value = valueRef.current;

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
