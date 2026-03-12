import type { PostHog } from "posthog-js";

export const captureError = (posthog: PostHog, error: unknown) => {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error(error);
  }

  posthog.captureException(error);
};
