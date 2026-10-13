import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import { describeAuthRefusal } from "@/api/lib/auth/auth-refusal-log";
import { logger } from "@/api/lib/observability/logger";
import {
  getCurrentRequestId,
  markMountedRequestRoute,
} from "@/api/lib/observability/request-context";

/** Elysia clones the mounted Request. Mark the registered template before
 * any auth hook can refuse the request, using the enclosing scope. */
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

export const authRefusalLogPlugin = {
  id: "stella-auth-refusal-log",
  hooks: {
    after: [
      {
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          const refusal = describeAuthRefusal({
            path: ctx.path,
            returned: ctx.context.returned,
            body: ctx.body,
          });
          if (refusal.type === "refused") {
            logger.warn("auth.request_refused", {
              ...refusal.attributes,
              "request.id": getCurrentRequestId(),
            });
          }
          await Promise.resolve();
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
