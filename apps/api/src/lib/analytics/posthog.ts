import { PostHog } from "posthog-node";

import type { Analytics } from "@/api/lib/analytics/types";

export const createPostHogAnalytics = (
  key: string,
  host: string,
): Analytics => {
  const client = new PostHog(key, { host });

  return {
    capture: (params) => client.capture(params),
    identify: (params) => client.identify(params),
    // eslint-disable-next-line promise-function-async
    flush: () => client.flush(),
  };
};
