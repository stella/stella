import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { deleteBrowserSiteNoteOnTx } from "@/api/lib/chat/browser-site-notes/store";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: v.object({ noteId: resourceIdSchema("chatBrowserSiteNote") }),
  aggregateMutation: {
    type: "aggregate",
    aggregates: ["chatToolGrants"],
  },
} satisfies HandlerConfig;

/** Remove one of the member's research notes about a website. Idempotent. */
const deleteBrowserSiteNoteHandler = createSafeRootHandler(
  config,
  async function* ({
    params: { noteId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const owner = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        // The member's collection lock, shared with their website approvals.
        await withAggregateLock({ tx, aggregate: "chatToolGrants", id: owner });
        return await deleteBrowserSiteNoteOnTx(tx, {
          noteId,
          owner,
          recordAuditEvent,
        });
      }),
    );
    return Result.ok(deleted);
  },
);

export default deleteBrowserSiteNoteHandler;
