import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { defaultDatabaseRetry } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";

const config = {
  permissions: { chat: ["update"] },
  mcp: { type: "capability", reason: "chat_thread_ui" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
  body: t.Object({
    title: t.String({ minLength: 1, maxLength: 200 }),
  }),
} satisfies HandlerConfig;

// Renames a chat thread's title. Kept as its own slice (not folded into
// `updateThread`, which owns the web-search flag) so each PATCH carries one
// intent rather than a set of optional payload fields. Updates only an
// existing row scoped to the caller's org/user/workspace; a missing thread
// is a 404 rather than an upsert, so a rename never conjures an empty thread.
const renameThread = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    body,
    query: { workspaceId },
    params,
    safeDb,
    session,
    user,
    recordAuditEvent,
  }) {
    const title = body.title.trim();
    if (title.length === 0) {
      yield* Result.err(
        new HandlerError({
          status: 400,
          message: "Chat thread title must not be empty",
        }),
      );
    }

    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds: activeWorkspaceIds,
      workspaceId,
    });

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const threadPredicate = () =>
          and(
            eq(chatThreads.id, params.threadId),
            eq(chatThreads.organizationId, session.activeOrganizationId),
            eq(chatThreads.userId, user.id),
            scope.scope === "workspace"
              ? eq(chatThreads.workspaceId, scope.workspaceId)
              : isNull(chatThreads.workspaceId),
          );

        const [existing] = await tx
          .select({ id: chatThreads.id, title: chatThreads.title })
          .from(chatThreads)
          .where(threadPredicate())
          .limit(1);

        if (!existing) {
          return [];
        }

        await tx.update(chatThreads).set({ title }).where(threadPredicate());

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: existing.id,
          workspaceId: scope.scope === "workspace" ? scope.workspaceId : null,
          changes: {
            title: { old: existing.title, new: title },
          },
        });

        return [{ id: existing.id }];
      }, defaultDatabaseRetry),
    );

    if (result.length === 0) {
      yield* Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    // Re-index so global search finds the thread by its new title. Fire-and-
    // forget after the rename commits: indexing must never block or fail the
    // rename. Mirrors generate-thread-title.ts and send-message.ts.
    upsertChatThreadSearchDocument(params.threadId).catch(captureError);

    return Result.ok({ title });
  },
);

export default renameThread;
