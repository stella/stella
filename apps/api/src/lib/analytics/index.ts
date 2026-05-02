import { errorTag, logDevError } from "@/api/lib/errors/utils";

import { getAnalytics } from "./client";

export { getAnalytics } from "./client";
export { isLocalPostHogDebugEnabled } from "./client";

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
 * - Dev: full error logged to `console.error` *and* appended to
 *   `apps/api/.dev-logs/errors.jsonl` (with the same `context`
 *   below) so headless tools can read it without holding the dev
 *   tty. Both paths are dev-only.
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

  logDevError(error, context);

  getAnalytics().capture({
    distinctId: "server",
    event: "$exception",
    properties: {
      $exception_type: tag,
      ...context,
    },
  });
};
