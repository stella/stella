import { Result } from "better-result";

import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { listOAuthConnectionsForUser } from "@/api/lib/oauth-connections";

const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies SessionHandlerConfig;

const listOAuthConnections = createSafeSessionHandler(
  config,
  async function* (ctx) {
    const connections = yield* Result.await(
      listOAuthConnectionsForUser(ctx.user.id),
    );

    return Result.ok({ connections });
  },
);

export default listOAuthConnections;
