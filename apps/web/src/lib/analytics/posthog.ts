import { CancelledError } from "@tanstack/react-query";
import { posthog } from "posthog-js";

import { env } from "@/env";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import type { Analytics, WebAnalyticsEvent } from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/utils";

const isWebAnalyticsEvent = (event: string): event is WebAnalyticsEvent =>
  event === WEB_ANALYTICS_EVENTS.exception ||
  event === WEB_ANALYTICS_EVENTS.identify ||
  event === WEB_ANALYTICS_EVENTS.pagePerformance ||
  event === WEB_ANALYTICS_EVENTS.pageViewed;

/**
 * Initialize PostHog and return an Analytics adapter.
 *
 * Stella only sends error diagnostics through this adapter. Session
 * replay, heatmaps, autocapture, PostHog-managed pageviews/performance,
 * and remote PostHog feature configuration are structurally disabled here
 * rather than relying on deployment-specific environment settings. Basic
 * page events are explicit and sanitized below.
 */
export const createPostHogAnalytics = (
  key: string,
  host: string,
): { analytics: Analytics; client: typeof posthog | undefined } => {
  const localDebugEnabled = import.meta.env.DEV && env.VITE_POSTHOG_LOCAL_DEBUG;
  const client = posthog.init(key, {
    opt_out_capturing_by_default: import.meta.env.DEV && !localDebugEnabled,
    api_host: host,
    defaults: "2025-05-24",
    advanced_disable_decide: true,
    advanced_disable_feature_flags: true,
    advanced_disable_flags: true,
    autocapture: false,
    capture_exceptions: {
      capture_console_errors: false,
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
    },
    rageclick: false,
    capture_dead_clicks: false,
    disable_persistence: true,
    disable_product_tours: true,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_web_experiments: true,
    mask_all_text: true,
    mask_personal_data_properties: true,
    person_profiles: "identified_only",
    capture_heatmaps: false,
    capture_performance: false,
    capture_pageview: false,
    before_send: (event) => {
      if (import.meta.env.DEV && !localDebugEnabled) {
        return null;
      }

      return event && isWebAnalyticsEvent(event.event) ? event : null;
    },
  });

  // Attach app_version as a super-property so every captured event
  // carries the build's version. Set once here so call sites don't have to.
  posthog.register({ app_version: __APP_VERSION__ });

  const analytics: Analytics = {
    captureError: (error) => {
      if (error instanceof CancelledError) {
        return;
      }
      logDevError(error);
      posthog.captureException(error);
    },
    capturePagePerformance: ({ loadBucket, routeId }) => {
      void posthog.capture(WEB_ANALYTICS_EVENTS.pagePerformance, {
        load_bucket: loadBucket,
        route_id: routeId,
      });
    },
    capturePageViewed: ({ routeId }) => {
      void posthog.capture(WEB_ANALYTICS_EVENTS.pageViewed, {
        route_id: routeId,
      });
    },
    identifyUser: (user) => {
      const distinctId = posthog.get_distinct_id();
      
      if (distinctId === user.id) {
        return;
      }

      if (posthog._isIdentified() && distinctId !== user.id) {
        posthog.reset();
      }

      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
      });
    },
    reset: () => {
      posthog.reset();
    },
  };

  return { analytics, client };
};
