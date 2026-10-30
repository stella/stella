import { Result } from "better-result";
import * as v from "valibot";

import { loadChatToolGrants } from "@/api/handlers/chat/tools/chat-tool-grants";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  access: "read",
  query: v.object({ threadId: resourceIdSchema("chatThread") }),
} satisfies HandlerConfig;

/**
 * The stored approvals that apply in one conversation: the user's `always`
 * grants plus the grants given in that conversation. Bounded by the per-user
 * grant cap, so the list is one page.
 */
const listChatToolGrants = createSafeRootHandler(
  config,
  async function* ({ query: { threadId }, safeDb, session, user }) {
    const grants = yield* Result.await(
      loadChatToolGrants({
        chatThreadId: threadId,
        organizationId: session.activeOrganizationId,
        safeDb,
        userId: user.id,
      }),
    );
    return Result.ok({ grants });
  },
);

export default listChatToolGrants;
