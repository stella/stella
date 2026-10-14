import type { BetterAuthPlugin } from "better-auth";
import type { createAuthMiddleware } from "better-auth/api";

import { describeAuthRefusal } from "@/api/lib/auth/auth-refusal-log";
import { OAUTH_TOKEN_OBSERVATION } from "@/api/lib/auth/oauth-token-refusal";
import { logger } from "@/api/lib/observability/logger";
import { getCurrentRequestId } from "@/api/lib/observability/request-context";

/**
 * Logs each 4xx answer of an auth endpoint by its route pattern and protocol
 * error code (`describeAuthRefusal`), so a failing token refresh is visible
 * apart from every other refused call behind the catch-all auth route.
 */
export const createAuthRefusalLogPlugin = (
  middleware: typeof createAuthMiddleware,
) =>
  ({
    id: "stella-auth-refusal-log",
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: middleware(async (ctx) => {
            const requestId = getCurrentRequestId();
            const refusal = describeAuthRefusal({
              path: ctx.path,
              returned: ctx.context.returned,
              body: ctx.body,
              oauthObservation: Reflect.get(
                ctx.context,
                OAUTH_TOKEN_OBSERVATION,
              ),
              ...(requestId === undefined ? {} : { requestId }),
            });
            if (refusal.type === "refused") {
              logger.warn("auth.request_refused", refusal.attributes);
            }
            await Promise.resolve();
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
