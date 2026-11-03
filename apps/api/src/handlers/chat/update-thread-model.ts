import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_THREAD_PLACEHOLDER_TITLE } from "@stll/api-contract";
import { chatRunTargetSchema } from "@stll/api-contract/chat-run-target";

import { defaultDatabaseRetry } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  decodeChatModelSelection,
  isChatModelReasoningEffortAvailable,
  isChatModelSelectionAvailable,
} from "@/api/lib/chat-model-selection";
import {
  decodeChatRunTarget,
  encodeChatRunTarget,
} from "@/api/lib/chat-run-target";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  permissions: { chat: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  params: v.object({ threadId: resourceIdSchema("chatThread") }),
  query: v.object({ workspaceId: v.optional(resourceIdSchema("workspace")) }),
  body: v.object({
    model: v.union([v.string(), v.null()]),
    reasoningEffort: v.optional(
      v.union([
        v.literal("none"),
        v.literal("minimal"),
        v.literal("low"),
        v.literal("medium"),
        v.literal("high"),
        v.literal("xhigh"),
        v.literal("max"),
        v.null(),
      ]),
    ),
    /**
     * Where the thread's turns run, kept so a reload shows the same choice.
     * Omitted leaves the stored target as it is.
     */
    runTarget: v.optional(chatRunTargetSchema),
  }),
} satisfies HandlerConfig;

/** The audit change of a run target the request set; none when it left it. */
const runTargetChange = (
  stored: string | null,
  next: string | null | undefined,
) => (next === undefined ? {} : { chatRunTarget: { old: stored, new: next } });

const updateThreadModel = createSafeRootHandler(
  config,
  async function* ({
    getWorkspaceAccess,
    body,
    orgAIConfig,
    query: { workspaceId },
    params,
    safeDb,
    session,
    user,
    recordAuditEvent,
  }) {
    const { model } = body;
    const reasoningEffort = body.reasoningEffort ?? null;
    const runTarget =
      body.runTarget === undefined
        ? undefined
        : encodeChatRunTarget(body.runTarget);
    const runTargetSet =
      runTarget === undefined ? {} : { chatRunTarget: runTarget };
    if (model === null && reasoningEffort !== null) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Auto model selection cannot specify reasoning effort",
        }),
      );
    }
    if (model !== null) {
      const decoded = decodeChatModelSelection(model);
      if (
        !decoded ||
        !isChatModelSelectionAvailable({ ...decoded, orgAIConfig }) ||
        (reasoningEffort !== null &&
          !isChatModelReasoningEffortAvailable({
            ...decoded,
            reasoningEffort,
          }))
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Unknown or unavailable chat model selection",
          }),
        );
      }
    }

    const scope = yield* resolveChatScope({
      getWorkspaceAccess,
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
            chatModel: chatThreads.chatModel,
            chatReasoningEffort: chatThreads.chatReasoningEffort,
            chatRunTarget: chatThreads.chatRunTarget,
          })
          .from(chatThreads)
          .where(threadPredicate())
          .limit(1);

        if (existing) {
          await tx
            .update(chatThreads)
            .set({
              chatModel: model,
              chatReasoningEffort: reasoningEffort,
              ...runTargetSet,
            })
            .where(threadPredicate());

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
            resourceId: existing.id,
            workspaceId: scope.scope === "workspace" ? scope.workspaceId : null,
            changes: {
              chatModel: {
                old: existing.chatModel,
                new: model,
              },
              chatReasoningEffort: {
                old: existing.chatReasoningEffort,
                new: reasoningEffort,
              },
              ...runTargetChange(existing.chatRunTarget, runTarget),
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
            chatModel: model,
            chatReasoningEffort: reasoningEffort,
            chatRunTarget: runTarget ?? null,
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
                  chatModel: model,
                  chatReasoningEffort: reasoningEffort,
                  chatRunTarget: runTarget ?? null,
                },
              },
            },
          });

          return inserted;
        }

        const [racedExisting] = await tx
          .select({
            id: chatThreads.id,
            chatModel: chatThreads.chatModel,
            chatReasoningEffort: chatThreads.chatReasoningEffort,
            chatRunTarget: chatThreads.chatRunTarget,
          })
          .from(chatThreads)
          .where(threadPredicate())
          .limit(1);

        if (!racedExisting) {
          return [];
        }

        await tx
          .update(chatThreads)
          .set({
            chatModel: model,
            chatReasoningEffort: reasoningEffort,
            ...runTargetSet,
          })
          .where(threadPredicate());

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: racedExisting.id,
          workspaceId: resolvedWorkspaceId,
          changes: {
            chatModel: {
              old: racedExisting.chatModel,
              new: model,
            },
            chatReasoningEffort: {
              old: racedExisting.chatReasoningEffort,
              new: reasoningEffort,
            },
            ...runTargetChange(racedExisting.chatRunTarget, runTarget),
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

    return Result.ok({
      model,
      reasoningEffort,
      ...(runTarget === undefined
        ? {}
        : { runTarget: decodeChatRunTarget(runTarget) }),
    });
  },
);

export default updateThreadModel;
