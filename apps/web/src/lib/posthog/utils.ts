import type { PostHog } from "posthog-js";

export const captureError = (posthog: PostHog, error: Error) => {
  if (import.meta.env.DEV) {
    // biome-ignore lint/suspicious/noConsole: debug
    console.error(error);
  }

  posthog.captureException(error);
};
