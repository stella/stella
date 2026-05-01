import { PostHog } from "posthog-node";

import type { Analytics } from "@/api/lib/analytics/types";

const APP_VERSION = process.env["STELLA_VERSION"] ?? "dev";

export const createPostHogAnalytics = (
  key: string,
  host: string,
): Analytics => {
  const client = new PostHog(key, { host });

  return {
    capture: ({ properties, ...rest }) =>
      client.capture({
        ...rest,
        properties: { ...properties, app_version: APP_VERSION },
      }),
    identify: (params) => client.identify(params),
    // eslint-disable-next-line promise-function-async
    flush: () => client.flush(),
  };
};
