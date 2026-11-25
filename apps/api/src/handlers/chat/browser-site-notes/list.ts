import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { listNotedBrowserSites } from "@/api/lib/chat/browser-site-notes/store";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  access: "read",
} satisfies HandlerConfig;

/**
 * The research notes the agent keeps for the member, by website, for
 * Settings. Bounded by the per-member caps, so the list is one page.
 */
const listBrowserSiteNotes = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const sites = yield* Result.await(
      listNotedBrowserSites({
        owner: {
          organizationId: session.activeOrganizationId,
          userId: user.id,
        },
        safeDb,
      }),
    );
    return Result.ok({ sites });
  },
);

export default listBrowserSiteNotes;
