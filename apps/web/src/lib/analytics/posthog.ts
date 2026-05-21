import { CancelledError } from "@tanstack/react-query";
import { posthog } from "posthog-js";

import { env } from "@/env";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import type { Analytics, WebAnalyticsEvent } from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/utils";

const isWebAnalyticsEvent = (event: string): event is WebAnalyticsEvent =>
  event === WEB_ANALYTICS_EVENTS.exception ||
  event === WEB_ANALYTICS_EVENTS.identify ||
  event === WEB_ANALYTICS_EVENTS.pageViewed;

// Browser-noise patterns we drop client-side before they hit
// PostHog ingest. PostHog has no built-in `ignoreErrors` analogue
// to Sentry's, so the canonical filter point is `before_send`.
//
// - `ResizeObserver loop ...`: benign Chromium/Firefox quirk that
//   fires when a ResizeObserver callback queues another resize.
// - `Script error.`: W3C-mandated cross-origin sanitization with
//   no payload — not actionable.
// - Empty / `undefined` rejection values: produced by
//   `capture_unhandled_rejections: true` catching a
//   `Promise.reject()` that carries no reason. No stack, no
//   message — filtering loses zero debuggable signal.
const EXCEPTION_NOISE_PATTERNS: readonly RegExp[] = [
  /^ResizeObserver loop/iu,
  /^Script error\.?$/iu,
  /^(?:Error: )?undefined$/iu,
  // Match only the empty form, not rejections that carry a useful
  // string (e.g. `Promise.reject("API_TIMEOUT")`) which we want to
  // keep capturing.
  /^Non-Error promise rejection captured with value: (?:undefined|null)$/iu,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readStringField = (entry: unknown, key: string): string => {
  if (!isRecord(entry)) {
    return "";
  }
  const value = entry[key];
  return typeof value === "string" ? value : "";
};

const isNoiseException = (event: {
  properties?: Record<string, unknown>;
}): boolean => {
  const list = event.properties?.["$exception_list"];
  if (!Array.isArray(list) || list.length === 0) {
    return false;
  }
  const entries: unknown[] = list;
  return entries.some((entry) => {
    const value = readStringField(entry, "value");
    const type = readStringField(entry, "type");
    return EXCEPTION_NOISE_PATTERNS.some(
      (pattern) => pattern.test(value) || pattern.test(type),
    );
  });
};

/**
 * Initialize PostHog and return an Analytics adapter.
 *
 * Stella only sends error diagnostics through this adapter. Session
 * replay, heatmaps, autocapture, and remote PostHog feature configuration are
 * structurally disabled here rather than relying on deployment-specific
 * environment settings.
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
      if (!event || !isWebAnalyticsEvent(event.event)) {
        return null;
      }
      if (
        event.event === WEB_ANALYTICS_EVENTS.exception &&
        isNoiseException(event)
      ) {
        return null;
      }
      return event;
    },
  });

  // Attach build metadata as super-properties so every captured
  // event carries the exact deployed build.
  posthog.register({
    app_commit: __APP_COMMIT_SHA__,
    app_version: __APP_VERSION__,
  });

  const analytics: Analytics = {
    captureError: (error) => {
      // Cheap guards before the SDK call: a stray `captureError(null)`
      // or `captureError(undefined)` would otherwise reach PostHog as
      // `Error: "undefined"` noise that the `before_send` filter then
      // has to clean up.
      if (
        error === null ||
        error === undefined ||
        error instanceof CancelledError
      ) {
        return;
      }
      logDevError(error);
      posthog.captureException(error);
    },
    capturePageViewed: ({ path }) => {
      posthog.capture(WEB_ANALYTICS_EVENTS.pageViewed, {
        path,
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
    reset: ({ onlyIfIdentified } = {}) => {
      if (onlyIfIdentified && !posthog._isIdentified()) {
        return;
      }

      posthog.reset();
    },
  };

  return { analytics, client };
};
