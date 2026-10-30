import { panic, Result } from "better-result";
import * as v from "valibot";

import { chatMessageAcceptedEditSchema } from "@stll/api-contract/chat-message-revisions";

import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { writeChatMessageRevisionOnTx } from "@/api/handlers/chat/messages/revisions/revision-on-tx";
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";

export const revisionParams = v.object({
  threadId: resourceIdSchema("chatThread"),
  messageId: resourceIdSchema("chatMessage"),
});
export const revisionNumber = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(2_147_483_646),
);

const config = {
  contract: "replace",
  precondition: {
    type: "deferred",
    baselineId: "apps/api/src/handlers/chat/messages/revisions/accept.ts",
  },
  description:
    "Accept an edit to a settled assistant answer with optimistic concurrency and a retained snapshot.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: revisionParams,
  body: v.object({
    baseRevision: revisionNumber,
    selectedTextHash: v.pipe(
      v.string(),
      v.regex(/^[a-f0-9]{64}$/u),
      v.maxLength(64),
    ),
    content: v.object({
      version: v.literal(3),
      data: v.pipe(v.array(v.unknown()), v.minLength(1), v.maxLength(1000)),
      metadata: v.optional(v.unknown()),
    }),
    edit: chatMessageAcceptedEditSchema,
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
            change: { type: "accept", ...body },
            recordAuditEvent,
          }),
      ),
    );
    if (result.type === "ok") {
      upsertChatThreadSearchDocument(threadId).catch(
        createErrorCapture(
          handlerErrorContext(
            "acceptMessageRevision.upsertChatThreadSearchDocument",
          ),
        ),
      );
    }
    return revisionResult(result);
  },
);

declareAggregateMutation(acceptMessageRevision, {
  type: "aggregate",
  aggregates: ["chatThread", "chatMessage"],
});

export default acceptMessageRevision;
