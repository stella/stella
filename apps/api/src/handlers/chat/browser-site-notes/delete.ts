import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { deleteBrowserSiteNote } from "@/api/lib/chat/browser-site-notes/store";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: v.object({ noteId: resourceIdSchema("chatBrowserSiteNote") }),
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
    const deleted = yield* Result.await(
      deleteBrowserSiteNote({
        noteId,
        owner: {
          organizationId: session.activeOrganizationId,
          userId: user.id,
        },
        recordAuditEvent,
        safeDb,
      }),
    );
    return Result.ok(deleted);
  },
);

declareAggregateMutation(deleteBrowserSiteNoteHandler, {
  type: "aggregate",
  aggregates: ["chatToolGrants"],
});

export default deleteBrowserSiteNoteHandler;
