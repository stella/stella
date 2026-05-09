import { PostHog } from "posthog-node";

import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";
import type {
  Analytics,
  ServerAnalyticsCaptureParams,
} from "@/api/lib/analytics/types";

const APP_VERSION = process.env["STELLA_VERSION"] ?? "dev";
const APP_COMMIT_SHA = process.env["STELLA_COMMIT_SHA"] ?? "dev";
const ALLOWED_EVENTS = new Set<ServerAnalyticsCaptureParams["event"]>(
  Object.values(SERVER_ANALYTICS_EVENTS),
);

export const createPostHogAnalytics = (
  key: string,
  host: string,
): Analytics => {
  const client = new PostHog(key, { host });

  return {
    capture: ({ event, properties, ...rest }) => {
      if (!ALLOWED_EVENTS.has(event)) {
        return;
      }

      client.capture({
        event,
        ...rest,
        properties: {
          ...properties,
          app_commit: APP_COMMIT_SHA,
          app_version: APP_VERSION,
        },
      });
    },
    // eslint-disable-next-line promise-function-async
    flush: () => client.flush(),
  };
};
