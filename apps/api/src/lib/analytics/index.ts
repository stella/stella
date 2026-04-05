import { env } from "@/api/env";
import { shouldEnablePostHog } from "@/api/lib/analytics/config";
import { noopAnalytics } from "@/api/lib/analytics/noop";
import { createPostHogAnalytics } from "@/api/lib/analytics/posthog";
import type { Analytics } from "@/api/lib/analytics/types";
import { errorTag, logDevError } from "@/api/lib/errors/utils";

let analytics: Analytics | null = null;

export const isLocalPostHogDebugEnabled = (): boolean =>
  env.isDev && env.POSTHOG_LOCAL_DEBUG;

export const getAnalytics = (): Analytics => {
  if (analytics) {
    return analytics;
  }

  const key = env.POSTHOG_KEY;
  const host = env.POSTHOG_HOST;
  analytics =
    shouldEnablePostHog({
      isDev: env.isDev,
      key,
      host,
      localDebug: env.POSTHOG_LOCAL_DEBUG,
    }) &&
    key &&
    host
      ? createPostHogAnalytics(key, host)
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

  logDevError(error);

  getAnalytics().capture({
    distinctId: "server",
    event: "$exception",
    properties: {
      $exception_type: tag,
      ...context,
    },
  });
};
