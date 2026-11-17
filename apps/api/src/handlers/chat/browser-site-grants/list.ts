import { Result } from "better-result";

import { loadBrowserSiteGrants } from "@/api/handlers/chat/browser-site-grants/load";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  access: "read",
} satisfies HandlerConfig;

/**
 * The websites the user lets chat's browser actions run on without asking.
 * Bounded by the per-user cap, so the list is one page.
 */
const listBrowserSiteGrants = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const grants = yield* Result.await(
      loadBrowserSiteGrants({
        organizationId: session.activeOrganizationId,
        safeDb,
        userId: user.id,
      }),
    );
    return Result.ok({ grants });
  },
);

export default listBrowserSiteGrants;
