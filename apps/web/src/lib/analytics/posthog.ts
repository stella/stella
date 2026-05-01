import { CancelledError } from "@tanstack/react-query";
import { posthog } from "posthog-js";

import { env } from "@/env";
import type { Analytics } from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/utils";

/**
 * Initialize PostHog and return an Analytics adapter.
 *
 * All PostHog-specific configuration (session recording,
 * heatmaps, masking) lives here. Consumers only see the
 * generic Analytics interface.
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
    autocapture: localDebugEnabled,
    capture_exceptions: true,
    rageclick: true,
    capture_dead_clicks: true,
    mask_all_text: true,
    mask_personal_data_properties: true,
    capture_heatmaps: true,
    capture_performance: true,
    capture_pageview: true,
    disable_session_recording: import.meta.env.DEV && !localDebugEnabled,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
    },
    before_send: (event) => {
      if (import.meta.env.DEV && !localDebugEnabled) {
        return null;
      }
      return event;
    },
  });

  // Attach app_version as a super-property so every captured event
  // (including pageviews, exceptions, and session recordings) carries
  // the build's version. Set once here so call sites don't have to.
  posthog.register({ app_version: __APP_VERSION__ });

  const analytics: Analytics = {
    capture: (event, properties) => {
      void posthog.capture(event, properties);
    },
    captureError: (error) => {
      if (error instanceof CancelledError) {
        return;
      }
      logDevError(error);
      posthog.captureException(error);
    },
  };

  return { analytics, client };
};
