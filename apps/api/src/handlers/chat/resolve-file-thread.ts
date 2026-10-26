import { Result } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { fileChatThreads } from "@/api/db/schema";
import {
  type FileThreadLookupInput,
  lockFileChatThreadMapping,
} from "@/api/handlers/chat/file-thread-mapping";
import {
  createFileChatThread,
  loadResolvedThreadMessagePage,
  loadWebSearchAvailable,
} from "@/api/handlers/chat/file-thread-shared";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

const resolveFileThreadBodySchema = v.object({
  entityId: resourceIdSchema("entity"),
  fieldId: resourceIdSchema("field"),
  threadId: v.optional(resourceIdSchema("chatThread")),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Resolves the conversation associated with a file without delivering stored bytes.",
  },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  body: resolveFileThreadBodySchema,
} satisfies WorkspaceHandlerConfig;

const resolveFileThread = createSafeHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const input: FileThreadLookupInput = {
      entityId: body.entityId,
      fieldId: body.fieldId,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      workspaceId,
    };

    const txResult = await safeDb(async (tx) => {
      const webSearchAvailable = await loadWebSearchAvailable(
        tx,
        input.organizationId,
      );

      // One indexed read both fences the unique mapping slot and resolves its
      // thread. The left join deliberately preserves a visible mapping whose
      // historical thread is hidden by chat-thread RLS, so that branch can
      // detach it without issuing a second lookup.
      const mapping = await lockFileChatThreadMapping(tx, input);
      const existing = mapping?.thread;

      if (existing) {
        const messagePage = await loadResolvedThreadMessagePage({
          tx,
          threadId: existing.id,
          userId: input.userId,
          organizationId: input.organizationId,
          orgAIConfig,
          webSearchAvailable,
          chatModel: existing.chatModel,
          chatReasoningEffort: existing.chatReasoningEffort,
          contextMatterIds: existing.contextMatterIds,
          usedAnonymization: existing.usedAnonymization,
          webSearchEnabled: existing.webSearchEnabled,
        });

        return {
          ok: true as const,
          chatThreadId: existing.id,
          messagePage,
        };
      }

      if (mapping !== undefined) {
        // Keep the inaccessible historical thread intact, but detach the
        // destination file from it. The unique mapping slot can then point to
        // a new B-scoped thread that the current user may actually open.
        await tx
          .delete(fileChatThreads)
          .where(eq(fileChatThreads.id, mapping.id));
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: mapping.mappedChatThreadId,
          workspaceId: input.workspaceId,
          metadata: {
            entityId: input.entityId,
            fieldId: input.fieldId,
            reason: "replace_inaccessible_file_chat_thread",
          },
        });
      }

      return await createFileChatThread(
        tx,
        input,
        recordAuditEvent,
        orgAIConfig,
        webSearchAvailable,
        body.threadId,
      );
    });

    if (Result.isError(txResult)) {
      if (
        !DatabaseError.is(txResult.error) ||
        txResult.error.code !== PG_ERROR.UNIQUE_VIOLATION
      ) {
        return yield* Result.err(txResult.error);
      }

      const recovered = yield* Result.await(
        safeDb(async (tx) => {
          const webSearchAvailable = await loadWebSearchAvailable(
            tx,
            input.organizationId,
          );

          const mapping = await lockFileChatThreadMapping(tx, input);
          if (!mapping?.thread) {
            return null;
          }

          const messagePage = await loadResolvedThreadMessagePage({
            tx,
            threadId: mapping.thread.id,
            userId: input.userId,
            organizationId: input.organizationId,
            orgAIConfig,
            webSearchAvailable,
            chatModel: mapping.thread.chatModel,
            chatReasoningEffort: mapping.thread.chatReasoningEffort,
            contextMatterIds: mapping.thread.contextMatterIds,
            usedAnonymization: mapping.thread.usedAnonymization,
            webSearchEnabled: mapping.thread.webSearchEnabled,
          });

          return { chatThreadId: mapping.thread.id, messagePage };
        }),
      );

      if (recovered) {
        return Result.ok({
          threadId: recovered.chatThreadId,
          ...recovered.messagePage,
        });
      }

      return yield* Result.err(
        new HandlerError({
          status: 404,
          message: "File not found",
        }),
      );
    }

    if (!txResult.value.ok) {
      return yield* Result.err(
        new HandlerError({
          status: txResult.value.status,
          message: txResult.value.message,
        }),
      );
    }

    return Result.ok({
      threadId: txResult.value.chatThreadId,
      ...txResult.value.messagePage,
    });
  },
);

export default resolveFileThread;
