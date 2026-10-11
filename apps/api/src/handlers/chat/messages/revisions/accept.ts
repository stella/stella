import { Type } from "@sinclair/typebox";
import { Result } from "better-result";
import { t } from "elysia";

import {
  chatMessageAcceptedEditSchema,
  type ChatMessageAcceptedEdit,
} from "@stll/api-contract/chat-message-revisions";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import type { writeChatMessageRevisionOnTx } from "@/api/handlers/chat/messages/revisions/revision-on-tx";
import {
  readRevisionMessageOnTx,
  writeAcceptedChatMessageRevisionOnTx,
} from "@/api/handlers/chat/messages/revisions/revision-on-tx";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { jsonSchemaToTypeBox } from "@/api/lib/json-schema/json-schema-to-typebox";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";

export const revisionParams = t.Object({
  threadId: tSafeId("chatThread"),
  messageId: tSafeId("chatMessage"),
});
export const revisionNumber = t.Integer({ minimum: 0, maximum: 2_147_483_646 });

const acceptedEditSchema = Type.Unsafe<ChatMessageAcceptedEdit>(
  jsonSchemaToTypeBox(toJsonSchema(chatMessageAcceptedEditSchema)),
);

const config = {
  contract: "replace",
  precondition: {
    type: "revision",
    fields: ["baseRevision", "selectedTextHash"],
  },
  description:
    "Accept an edit to a settled assistant answer with optimistic concurrency and a retained snapshot.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: revisionParams,
  body: t.Object({
    baseRevision: revisionNumber,
    selectedTextHash: t.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 }),
    content: t.Object({
      version: t.Literal(3),
      data: t.Array(t.Unknown(), { minItems: 1, maxItems: 1000 }),
      metadata: t.Optional(t.Unknown()),
    }),
    edit: acceptedEditSchema,
  }),
} satisfies HandlerConfig;

export const revisionResult = (
  result: Awaited<ReturnType<typeof writeChatMessageRevisionOnTx>>,
) => {
  if (HandlerError.is(result)) {
    return Result.err(result);
  }
  return Result.ok({ revision: result.revision, edited: result.edited });
};

const acceptMessageRevision = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { threadId, messageId },
    safeDb,
    getWorkspaceAccess,
    user,
    session,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const loaded = await readRevisionMessageOnTx({
          tx,
          getWorkspaceAccess,
          threadId,
          messageId,
          userId: user.id,
          organizationId: session.activeOrganizationId,
        });
        return await writeAcceptedChatMessageRevisionOnTx({
          tx,
          loaded,
          threadId,
          messageId,
          userId: user.id,
          change: {
            type: "accept",
            baseRevision: body.baseRevision,
            selectedTextHash: body.selectedTextHash,
            content: body.content,
            edit: body.edit,
          },
          recordAuditEvent,
        });
      }),
    );
    if (HandlerError.is(result)) {
      return Result.err(result);
    }
    if (result.type === "ok") {
      upsertChatThreadSearchDocument(threadId).catch(captureError);
    }
    return revisionResult(result);
  },
);

declareAggregateMutation(acceptMessageRevision.handler, {
  type: "aggregate",
  aggregates: ["chatThread", "chatMessage"],
});

export default acceptMessageRevision;
