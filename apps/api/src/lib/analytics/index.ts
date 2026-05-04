import { errorTag, logDevError } from "@/api/lib/errors/utils";
import { getRequestContext } from "@/api/lib/observability/request-context";

import { getAnalytics } from "./client";
import { SERVER_ANALYTICS_EVENTS } from "./types";

export { getAnalytics } from "./client";
export { isLocalPostHogDebugEnabled } from "./client";

/**
 * Capture an error for observability.
 *
 * - Dev: full error logged to `console.error` *and* appended to
 *   `apps/api/.dev-logs/errors.jsonl` (with the same `context`
 *   below) so headless tools can read it without holding the dev
 *   tty. Both paths are dev-only.
 * - Prod: only the structural error tag (class name), safe
 *   caller-provided correlation context, and authenticated
 *   request correlation IDs are sent to the analytics provider.
 *   Error messages, causes, and stack traces are never sent;
 *   they may contain privileged document content, file names,
 *   or client data.
 *
 * Pass `context` with safe correlation IDs (entity IDs, request
 * IDs) to make errors traceable without leaking content.
 */
type ErrorTelemetryContext = Record<string, string>;

type CaptureErrorOptions = {
  context?: ErrorTelemetryContext | undefined;
  distinctId?: string | undefined;
  organizationId?: string | undefined;
  sessionId?: string | undefined;
};

type CaptureRequestErrorOptions = {
  context?: ErrorTelemetryContext | undefined;
  request: Request;
};

const SERVER_DISTINCT_ID = "server";

const captureErrorWithOptions = (
  error: unknown,
  options: CaptureErrorOptions,
) => {
  const tag = errorTag(error);
  const properties = {
    $exception_type: tag,
    ...options.context,
    ...(options.organizationId
      ? { organization_id: options.organizationId }
      : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  };

  logDevError(error, properties);

  getAnalytics().capture({
    distinctId: options.distinctId ?? SERVER_DISTINCT_ID,
    event: SERVER_ANALYTICS_EVENTS.exception,
    properties,
  });
};

export const captureError = (
  error: unknown,
  context?: ErrorTelemetryContext,
) => {
  captureErrorWithOptions(error, { context });
};

export const captureRequestError = (
  error: unknown,
  { context, request }: CaptureRequestErrorOptions,
) => {
  const reqCtx = getRequestContext(request);
  captureErrorWithOptions(error, {
    context,
    distinctId: reqCtx?.posthogDistinctId,
    organizationId: reqCtx?.organizationId,
    sessionId: reqCtx?.sessionId,
  });
};
