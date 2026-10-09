import { Type } from "@sinclair/typebox";
import { panic, Result } from "better-result";
import { t } from "elysia";

import {
  chatMessageAcceptedEditSchema,
  type ChatMessageAcceptedEdit,
} from "@stll/api-contract/chat-message-revisions";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { writeChatMessageRevisionOnTx } from "@/api/handlers/chat/messages/revisions/revision-on-tx";
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
  description:
    "Accept an edit to a settled assistant answer with optimistic concurrency and a retained snapshot.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: revisionParams,
  body: t.Object({
    baseRevision: revisionNumber,
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
  switch (result.type) {
    case "ok":
      return Result.ok({ revision: result.revision, edited: result.edited });
    case "not-found":
      return Result.err(
        new HandlerError({ status: 404, message: "Chat message not found" }),
      );
    case "revision-not-found":
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat message revision not found",
        }),
      );
    case "stale":
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "Message revision changed; reload the message before editing",
        }),
      );
    case "unsettled":
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Wait for the assistant turn to settle before editing",
        }),
      );
    case "not-assistant":
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Only assistant answers can be edited",
        }),
      );
    case "invalid-content":
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Answer edits must preserve metadata and non-text parts",
        }),
      );
    case "invalid-edit":
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Edit range must refer to text in the current answer",
        }),
      );
    default:
      result satisfies never;
      return panic("Unhandled chat revision result");
  }
};

const acceptMessageRevision = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { threadId, messageId },
    safeDb,
    user,
    session,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await writeChatMessageRevisionOnTx({
            tx,
            threadId,
            messageId,
            userId: user.id,
            organizationId: session.activeOrganizationId,
            change: { type: "accept", ...body },
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

declareAggregateMutation(acceptMessageRevision.handler, {
  type: "aggregate",
  aggregates: ["chatThread", "chatMessage"],
});

export default acceptMessageRevision;
