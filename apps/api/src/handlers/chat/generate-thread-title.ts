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
import { isUnanticipatedAIFailure } from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import {
  readThreadStoredContentSendModeOnTx,
  THREAD_STORED_CONTENT_SEND_MODE,
} from "@/api/lib/chat/thread-stored-content-send-mode";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { startExecutionAdmission } from "@/api/lib/rate-limit/execution-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

const TITLE_GENERATION_TIMEOUT_MS = 10_000;

const SEND_MODE_READ_FAILED_SINK = failureSink({
  event: "chat.thread_title.send_mode_read_failed",
  expected: [],
});

const TITLE_ADMISSION_FAILED = failureSink({
  event: "chat.thread_title.admission_failed",
  expected: [],
});

type GenerateThreadTitleProps = {
  /** Refreshes the thread's search document once the title changed; the
   *  caller supplies it so the title's database access stays with its own. */
  indexThread: typeof upsertChatThreadSearchDocument;
  initialTitle: string;
  messages: [ChatMessage, ChatMessage]; // [userMessage, AIMessage]
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  threadWorkspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
};

const generateAdmittedThreadTitle = async ({
  admissionSignal,
  modelAdmission,
  indexThread,
  initialTitle,
  messages,
  organizationId,
  orgAIConfig,
  managedAIResidency,
  promptCachingEnabled,
  recordAuditEvent,
  safeDb,
  threadId,
  threadWorkspaceId,
  userId,
}: GenerateThreadTitleProps & {
  admissionSignal: AbortSignal;
  modelAdmission: ModelDispatchAdmission;
}): Promise<void> => {
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
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

  // Queued by a raw turn; read again before sending, since the thread may
  // have switched to anonymized mode since.
  const sendMode = await safeDb(
    async (tx) => await readThreadStoredContentSendModeOnTx({ threadId, tx }),
  );
  if (Result.isError(sendMode)) {
    observeFailure(sendMode.error, { sink: SEND_MODE_READ_FAILED_SINK });
    return;
  }
  if (sendMode.value === THREAD_STORED_CONTENT_SEND_MODE.anonymized) {
    return;
  }

  const generated = await Result.tryPromise({
    try: async () =>
      await generateTanStackTextForRole({
        dataClass: "customer",
        abortSignal: AbortSignal.any([
          AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS),
          admissionSignal,
        ]),
        finishPolicy: TITLE_FINISH_POLICY,
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
        role: "fast",
        serviceTier: "batch",
        orgAIConfig,
        managedAIResidency,
        organizationId,
        admission: modelAdmission,
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled,
          role: "fast",
          scopeKey: threadId,
        }),
        tenantWorkspaceIds: threadWorkspaceId ? [threadWorkspaceId] : [],
        prompt: buildThreadTitlePrompt(messages),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(generated)) {
    aiAnalytics.captureError(generated.error);
    if (isUnanticipatedAIFailure(generated.error)) {
      captureError(generated.error, { threadId });
    }
    return;
  }
  const text = generated.value;

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
        titleChanged: { old: false, new: true },
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

  // Re-index so the new AI-generated title is searchable. Best effort:
  // a failure is reported, never thrown. Awaited, so whoever waits for
  // this title (the turn's follow-ups) waits for its indexing too.
  if (updateResult.value) {
    await indexThread(threadId).catch(captureError);
  }
};

// A detached title outlives the chat attempt and therefore owns a fresh lease.
export const generateThreadTitle = async (
  props: GenerateThreadTitleProps,
): Promise<void> => {
  const admitted = await startExecutionAdmission({
    mode: "concurrency-only",
    actionKind: "chat.generate-thread-title",
    organizationId: props.organizationId,
    userId: props.userId,
  });
  if (Result.isError(admitted)) {
    observeFailure(admitted.error, {
      sink: TITLE_ADMISSION_FAILED,
      ctx: { threadId: props.threadId },
    });
    return;
  }
  try {
    await generateAdmittedThreadTitle({
      ...props,
      admissionSignal: admitted.value.signal,
      modelAdmission: admitted.value.modelAdmission,
    });
  } finally {
    await admitted.value.release();
  }
};
