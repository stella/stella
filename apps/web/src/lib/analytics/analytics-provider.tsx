import { useState } from "react";
import type { PropsWithChildren } from "react";

import { PostHogProvider } from "@posthog/react";

import {
  AnalyticsContext,
  type AnalyticsValue,
} from "@/lib/analytics/provider";

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
