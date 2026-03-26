import { posthog } from "posthog-js";

import type { Analytics } from "@/lib/analytics/types";

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
  const client = posthog.init(key, {
    opt_out_capturing_by_default: import.meta.env.DEV,
    api_host: host,
    defaults: "2025-05-24",
    autocapture: false,
    capture_exceptions: true,
    rageclick: true,
    capture_dead_clicks: true,
    mask_all_text: true,
    mask_personal_data_properties: true,
    capture_heatmaps: true,
    capture_performance: true,
    capture_pageview: true,
    disable_session_recording: import.meta.env.DEV,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
    },
    before_send: (event) => {
      if (import.meta.env.DEV) {
        return null;
      }
      return event;
    },
  });

  const analytics: Analytics = {
    capture: (event, properties) => posthog.capture(event, properties),
    captureError: (error) => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.error(error);
      }
      posthog.captureException(error);
    },
  };

  return { analytics, client };
};
