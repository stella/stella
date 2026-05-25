import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { defaultDatabaseRetry } from "@/api/db";
import { chatThreads } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { CHAT_THREAD_PLACEHOLDER_TITLE } from "@/api/handlers/chat/thread-title";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["update"] },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
  body: t.Object({
    webSearchEnabled: t.Boolean(),
  }),
} satisfies HandlerConfig;

const updateThread = createSafeRootHandler(
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
          .select({
            id: chatThreads.id,
            webSearchEnabled: chatThreads.webSearchEnabled,
          })
          .from(chatThreads)
          .where(threadPredicate())
          .limit(1);

        if (existing) {
          await tx
            .update(chatThreads)
            .set({ webSearchEnabled: body.webSearchEnabled })
            .where(threadPredicate());

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
            resourceId: existing.id,
            workspaceId: scope.scope === "workspace" ? scope.workspaceId : null,
            changes: {
              webSearchEnabled: {
                old: existing.webSearchEnabled,
                new: body.webSearchEnabled,
              },
            },
          });

          return [{ id: existing.id }];
        }

        const resolvedWorkspaceId =
          scope.scope === "workspace" ? scope.workspaceId : null;
        const dataWorkspaceIds =
          scope.scope === "workspace" ? [scope.workspaceId] : [];

        const inserted = await tx
          .insert(chatThreads)
          .values({
            id: params.threadId,
            organizationId: session.activeOrganizationId,
            title: CHAT_THREAD_PLACEHOLDER_TITLE,
            userId: user.id,
            workspaceId: resolvedWorkspaceId,
            contextMatterIds: [],
            dataWorkspaceIds,
            webSearchEnabled: body.webSearchEnabled,
          })
          .onConflictDoNothing()
          .returning({ id: chatThreads.id });

        const insertedThread = inserted.at(0);
        if (insertedThread) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
            resourceId: insertedThread.id,
            workspaceId: resolvedWorkspaceId,
            changes: {
              created: {
                old: null,
                new: {
                  title: CHAT_THREAD_PLACEHOLDER_TITLE,
                  webSearchEnabled: body.webSearchEnabled,
                },
              },
            },
          });

          return inserted;
        }

        const [racedExisting] = await tx
          .select({
            id: chatThreads.id,
            webSearchEnabled: chatThreads.webSearchEnabled,
          })
          .from(chatThreads)
          .where(threadPredicate())
          .limit(1);

        if (!racedExisting) {
          return [];
        }

        await tx
          .update(chatThreads)
          .set({ webSearchEnabled: body.webSearchEnabled })
          .where(threadPredicate());

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: racedExisting.id,
          workspaceId: resolvedWorkspaceId,
          changes: {
            webSearchEnabled: {
              old: racedExisting.webSearchEnabled,
              new: body.webSearchEnabled,
            },
          },
        });

        return [{ id: racedExisting.id }];
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

    return Result.ok({ webSearchEnabled: body.webSearchEnabled });
  },
);

export default updateThread;
