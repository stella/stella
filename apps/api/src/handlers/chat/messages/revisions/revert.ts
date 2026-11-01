import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import {
  revisionNumber,
  revisionResult,
} from "@/api/handlers/chat/messages/revisions/accept";
import { writeChatMessageRevisionOnTx } from "@/api/handlers/chat/messages/revisions/revision-on-tx";
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";

const config = {
  contract: "patch",
  description:
    "Restore a retained assistant answer snapshot as a new revision; require the current base revision.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: v.object({
    threadId: resourceIdSchema("chatThread"),
    messageId: resourceIdSchema("chatMessage"),
    revision: numberFromString(
      v.pipe(
        v.number(),
        v.minValue(0),
        v.maxValue(2_147_483_646),
        v.multipleOf(1),
      ),
    ),
  }),
  body: v.object({ baseRevision: revisionNumber }),
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
      upsertChatThreadSearchDocument(threadId).catch(
        createErrorCapture(
          handlerErrorContext(
            "revertMessageRevision.upsertChatThreadSearchDocument",
          ),
        ),
      );
    }
    return revisionResult(result);
  },
);

declareAggregateMutation(revertMessageRevision, {
  type: "aggregate",
  aggregates: ["chatThread", "chatMessage"],
});

export default revertMessageRevision;
