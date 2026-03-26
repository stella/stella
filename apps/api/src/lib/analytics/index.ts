import { env } from "@/api/env";
import { noopAnalytics } from "@/api/lib/analytics/noop";
import { createPostHogAnalytics } from "@/api/lib/analytics/posthog";
import type { Analytics } from "@/api/lib/analytics/types";
import { errorTag } from "@/api/lib/errors/utils";

let analytics: Analytics | null = null;

export const getAnalytics = (): Analytics => {
  if (analytics) {
    return analytics;
  }

  analytics =
    env.POSTHOG_KEY && env.POSTHOG_HOST
      ? createPostHogAnalytics(env.POSTHOG_KEY, env.POSTHOG_HOST)
      : noopAnalytics;

  return analytics;
};

type IdentifyProps = {
  distinctId: string;
  properties: {
    active_organization_id: string;
  };
};

export const identify = ({ distinctId, properties }: IdentifyProps) => {
  getAnalytics().identify({ distinctId, properties });
};

/**
 * Capture an error for observability.
 *
 * - Dev: full error logged to console for debugging.
 * - Prod: only the structural error tag (class name) is sent
 *   to the analytics provider. Error messages, causes, and
 *   stack traces are never sent; they may contain privileged
 *   document content, file names, or client data.
 *
 * Pass `context` with safe correlation IDs (entity IDs, request
 * IDs) to make errors traceable without leaking content.
 */
export const captureError = (
  error: unknown,
  context?: Record<string, string>,
) => {
  const tag = errorTag(error);

  if (env.isDev) {
    // eslint-disable-next-line no-console
    console.error(error);
  }

  getAnalytics().capture({
    distinctId: "server",
    event: "$exception",
    properties: {
      $exception_type: tag,
      ...context,
    },
  });
};
