import { useEffect, useRef } from "react";

import { useRouterState } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";

const UNKNOWN_ROUTE_ID = "__unknown__";

export const bucketPageLoadDuration = (durationMs: number): string => {
  if (durationMs < 250) {
    return "0_250";
  }
  if (durationMs < 500) {
    return "250_500";
  }
  if (durationMs < 1000) {
    return "500_1000";
  }
  if (durationMs < 2000) {
    return "1000_2000";
  }
  if (durationMs < 5000) {
    return "2000_5000";
  }
  return "5000_plus";
};

const getInitialLoadDuration = (): number => {
  const navigation = performance.getEntriesByType("navigation").at(0);
  if (navigation instanceof PerformanceNavigationTiming) {
    return navigation.duration;
  }
  return performance.now();
};

export const RouteTelemetry = () => {
  const analytics = useAnalytics();
  const routeId = useRouterState({
    select: (state) =>
      state.matches.at(-1)?.routeId.toString() ?? UNKNOWN_ROUTE_ID,
  });
  const hasCapturedInitialPerformanceRef = useRef(false);

  useEffect(() => {
    analytics.capturePageViewed({ routeId });

    if (!hasCapturedInitialPerformanceRef.current) {
      hasCapturedInitialPerformanceRef.current = true;
      analytics.capturePagePerformance({
        loadBucket: bucketPageLoadDuration(getInitialLoadDuration()),
        routeId,
      });
    }
  }, [analytics, routeId]);

  return null;
};
