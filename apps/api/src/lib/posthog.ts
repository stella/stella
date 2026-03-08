import { PostHog } from "posthog-node";

import { env } from "@/api/env";
import { errorTag } from "@/api/lib/errors/utils";

let posthogClient: PostHog | null = null;

export const getPostHog = () => {
  if (!posthogClient) {
    posthogClient = new PostHog(env.POSTHOG_KEY, {
      host: env.POSTHOG_HOST,
    });
  }

  return posthogClient;
};

type PosthogIdentifyProps = {
  distinctId: string;
  properties: {
    active_organization_id: string;
  };
};

export const posthogIdentify = ({
  distinctId,
  properties,
}: PosthogIdentifyProps) => {
  const posthog = getPostHog();

  posthog.identify({
    distinctId,
    properties,
  });
};

/**
 * Capture an error for observability.
 *
 * - Dev: full error logged to console for debugging.
 * - Prod: only the structural error tag (class name) is sent
 *   to PostHog. Error messages, causes, and stack traces are
 *   never sent; they may contain privileged document content,
 *   file names, or client data.
 *
 * Pass `context` with safe correlation IDs (entity IDs, request
 * IDs) to make errors traceable without leaking content.
 */
export const captureError = (
  error: unknown,
  context?: Record<string, string>,
) => {
  const posthog = getPostHog();
  const tag = errorTag(error);

  if (env.isDev) {
    // biome-ignore lint/suspicious/noConsole: full error in dev only
    console.error(error);
  }

  posthog.capture({
    distinctId: "server",
    event: "$exception",
    properties: {
      $exception_type: tag,
      ...context,
    },
  });
};
