import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import { createWebHandoffService } from "@/api/lib/auth/mcp-web-handoff";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

let webHandoffService: ReturnType<typeof createWebHandoffService> | undefined;

/**
 * The process-wide web handoff service. It lives outside `auth.ts` so that the
 * owner connection it needs for the handoff table does not join the matter
 * access census of the auth module.
 */
export const getWebHandoffService = () =>
  (webHandoffService ??= createWebHandoffService({
    db: rootDb,
    budget: new RedisRateLimitContext({ failurePolicy: "fail_closed" }),
    enabled: () => env.MCP_WEB_HANDOFF_MINT_ENABLED,
    textEnabled: () => env.MCP_WEB_HANDOFF_TEXT_ENABLED === "1",
  }));
