import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import type { createAuthMiddleware } from "better-auth/api";

import { describeAuthRefusal } from "@/api/lib/auth/auth-refusal-log";
import { OAUTH_TOKEN_OBSERVATION } from "@/api/lib/auth/oauth-token-refusal";
import { logger } from "@/api/lib/observability/logger";
import {
  getRequestId,
  markMountedRequestRoute,
} from "@/api/lib/observability/request-context";

/** Mark the Better Auth endpoint's registered template on the enclosing
 * request scope before any auth hook can refuse the request. */
export const markAuthRequestRoute = ({
  context,
  path,
}: Pick<HookEndpointContext, "context" | "path">): void => {
  if (!path) {
    return;
  }
  // Better Auth dispatch sets path from endpoint.path, before hooks run.
  markMountedRequestRoute(
    `${new URL(context.baseURL).pathname.replace(/\/$/u, "")}${path}`,
  );
};

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
            const requestId = getRequestId();
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
