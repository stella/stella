import { posthog } from "posthog-js";

import { env } from "@/env";

// https://posthog.com/docs/libraries/js/config
const initializePosthog = () =>
  posthog.init(env.VITE_POSTHOG_KEY, {
    opt_out_capturing_by_default: import.meta.env.DEV,
    api_host: env.VITE_POSTHOG_HOST,
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

export default initializePosthog;
