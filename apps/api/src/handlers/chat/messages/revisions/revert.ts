import { Result } from "better-result";
import { t } from "elysia";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  revisionNumber,
  revisionResult,
} from "@/api/handlers/chat/messages/revisions/accept";
import { writeChatMessageRevisionOnTx } from "@/api/handlers/chat/messages/revisions/revision-on-tx";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";

const config = {
  description:
    "Restore a retained assistant answer snapshot as a new revision; require the current base revision.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: t.Object({
    threadId: tSafeId("chatThread"),
    messageId: tSafeId("chatMessage"),
    revision: t.Numeric({ minimum: 0, maximum: 2_147_483_646, multipleOf: 1 }),
  }),
  body: t.Object({ baseRevision: revisionNumber }),
} satisfies HandlerConfig;

const revertMessageRevision = createSafeRootHandler(
  config,
  async function* ({
    body: { baseRevision },
    params: { threadId, messageId, revision },
    safeDb,
    getWorkspaceAccess,
    user,
    session,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await writeChatMessageRevisionOnTx({
            tx,
            getWorkspaceAccess,
            threadId,
            messageId,
            userId: user.id,
            organizationId: session.activeOrganizationId,
            change: { type: "revert", baseRevision, toRevision: revision },
            recordAuditEvent,
          }),
      ),
    );
    if (result.type === "ok") {
      upsertChatThreadSearchDocument(threadId).catch(captureError);
    }
    return revisionResult(result);
  },
);

declareAggregateMutation(revertMessageRevision.handler, {
  type: "aggregate",
  aggregates: ["chatThread", "chatMessage"],
});

export default revertMessageRevision;
