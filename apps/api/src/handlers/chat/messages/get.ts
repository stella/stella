import { Result } from "better-result";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { projectPageRowsOnTx } from "@/api/handlers/chat/message-page";
import { revisionParams } from "@/api/handlers/chat/messages/revisions/accept";
import { readEditableMessageOnTx } from "@/api/handlers/chat/messages/revisions/read-message";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Read the current chat answer and revision after an edit or selection conflict.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: revisionParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({
    params: { threadId, messageId },
    safeDb,
    getWorkspaceAccess,
    user,
    session,
  }) {
    const message = yield* Result.await(
      safeDb(async (tx) => {
        const loaded = await readEditableMessageOnTx({
          tx,
          getWorkspaceAccess,
          threadId,
          messageId,
          userId: user.id,
          organizationId: session.activeOrganizationId,
        });
        if (!loaded) {
          return null;
        }
        return (
          await projectPageRowsOnTx({
            tx,
            rows: [loaded.message],
            userId: user.id,
          })
        ).at(0);
      }),
    );
    if (!message) {
      return Result.err(
        new HandlerError({ status: 404, message: "Chat message not found" }),
      );
    }
    return Result.ok(message);
  },
);
