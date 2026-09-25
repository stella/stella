import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const OAUTH_CALLBACK_FAILURE = failureSink({
  event: "oauth_callback.failed",
  expected: [],
});

/**
 * The reason an OAuth callback redirects with after a failed step. A handler
 * error (a stored secret that does not decrypt to its envelope, a refused
 * lookup) is `invalid-secret`; anything else is `unexpected`. Every failure is
 * observed against the callback's request, and its grade decides whether it
 * is reported: a client-side handler error or a transient network failure is
 * logged as a warning, a server-side one is reported.
 */
export const oauthCallbackFailureReason = (
  error: unknown,
  {
    request,
    ...ctx
  }: {
    operation: string;
    organizationId: SafeId<"organization">;
    request: Request;
  },
): "invalid-secret" | "unexpected" => {
  observeFailure(error, { sink: OAUTH_CALLBACK_FAILURE, ctx, request });
  return HandlerError.is(error) ? "invalid-secret" : "unexpected";
};
