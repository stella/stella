import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { CHAT_TITLE_SOURCE, chatThreads } from "@/api/db/schema";
import { aiTitlingMayReplace } from "@/api/handlers/chat/thread-title";
import {
  buildThreadTitlePrompt,
  cleanGeneratedTitle,
  TITLE_FINISH_POLICY,
  TITLE_MAX_OUTPUT_TOKENS,
} from "@/api/handlers/chat/thread-title-prompt";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

const TITLE_GENERATION_TIMEOUT_MS = 10_000;

type GenerateThreadTitleProps = {
  initialTitle: string;
  messages: [ChatMessage, ChatMessage]; // [userMessage, AIMessage]
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  threadWorkspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
};

export const generateThreadTitle = async ({
  initialTitle,
  messages,
  organizationId,
  orgAIConfig,
  promptCachingEnabled,
  recordAuditEvent,
  safeDb,
  threadId,
  threadWorkspaceId,
  userId,
}: GenerateThreadTitleProps): Promise<void> => {
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "background",
      organizationId,
      safeDb,
      serviceTier: "batch",
      userId,
      workspaceId: threadWorkspaceId,
    },
    feature: "chat.thread_title",
    modelRole: "fast",
    orgAIConfig,
    properties: threadWorkspaceId ? { workspace_id: threadWorkspaceId } : {},
    traceId: Bun.randomUUIDv7(),
  });

  try {
    const text = await generateTanStackTextForRole({
      abortSignal: AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS),
      finishPolicy: TITLE_FINISH_POLICY,
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      role: "fast",
      serviceTier: "batch",
      orgAIConfig,
      organizationId,
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        role: "fast",
        scopeKey: threadId,
      }),
      tenantWorkspaceIds: threadWorkspaceId ? [threadWorkspaceId] : [],
      prompt: buildThreadTitlePrompt(messages),
    });

    const title = cleanGeneratedTitle(text);
    if (!title) {
      return;
    }

    const updateResult = await safeDb(async (tx) => {
      const currentThread = await tx.query.chatThreads.findFirst({
        where: {
          id: { eq: threadId },
        },
        columns: {
          title: true,
          titleSource: true,
        },
      });

      // Only replace a still-default placeholder title whose text still
      // matches what this request set at creation. A "user" rename or a
      // prior "ai" title is left untouched: the generator writes once, and a
      // rename that raced this fire-and-forget path must win.
      //
      // The title-text comparison (not just titleSource) also covers a
      // rolling-deploy window: an old API task's rename-thread implementation
      // predates titleSource and only writes `title`, so a rename it serves
      // leaves titleSource="default" behind. Requiring the title to still
      // equal initialTitle catches that stale-column case too, since any
      // rename necessarily changes the text.
      if (
        !currentThread ||
        !aiTitlingMayReplace(currentThread.titleSource) ||
        currentThread.title !== initialTitle
      ) {
        return false;
      }

      const updatedRows = await tx
        .update(chatThreads)
        .set({ title, titleSource: CHAT_TITLE_SOURCE.AI })
        .where(
          and(
            eq(chatThreads.id, threadId),
            // Re-check inside the UPDATE so a rename committing between the
            // read above and this write cannot be clobbered.
            eq(chatThreads.titleSource, CHAT_TITLE_SOURCE.DEFAULT),
            eq(chatThreads.title, initialTitle),
          ),
        )
        .returning({ id: chatThreads.id });

      if (updatedRows.length === 0) {
        return false;
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
        resourceId: threadId,
        workspaceId: threadWorkspaceId,
        changes: {
          title: { old: currentThread.title, new: title },
          titleSource: {
            old: currentThread.titleSource,
            new: CHAT_TITLE_SOURCE.AI,
          },
        },
      });

      return true;
    });

    if (Result.isError(updateResult)) {
      captureError(updateResult.error, { threadId });
      return;
    }

    // Re-index so the new AI-generated title is searchable. Fire-and-
    // forget: title generation is already a best-effort side path.
    if (updateResult.value) {
      upsertChatThreadSearchDocument(threadId).catch(captureError);
    }
  } catch (error) {
    aiAnalytics.captureError(error);
    captureError(error, { threadId });
  }
};
