import { panic, Result } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { CHAT_TITLE_SOURCE } from "@/api/db/schema";
import { readThreadTitleInput } from "@/api/handlers/chat/thread-title-input";
import {
  buildThreadTitlePrompt,
  cleanGeneratedTitle,
  TITLE_FINISH_POLICY,
  TITLE_MAX_OUTPUT_TOKENS,
} from "@/api/handlers/chat/thread-title-prompt";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { type OrgAIConfig, resolveCaching } from "@/api/lib/ai-config";
import { isUnanticipatedAIFailure } from "@/api/lib/ai-error";
import {
  generateArtefact,
  projectArtefactText,
  writeThreadArtefactTitle,
} from "@/api/lib/ai-generation/provenance";
import { captureError, createErrorCapture } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { startExecutionAdmission } from "@/api/lib/rate-limit/execution-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";

const TITLE_GENERATION_TIMEOUT_MS = 10_000;

/**
 * A title runs on the standard tier: the reader sees it the moment the first
 * turn ends, and a deferred tier bounds no latency at all, so a title queued
 * there outlives its deadline and is never written. Read by the
 * structured-output request settings test.
 *
 * @public
 */
export const TITLE_SERVICE_TIER = "standard";

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
  /** The organization's scope, read for the title's managed model tier. */
  organizationStateDb: ScopedDb;
  threadId: SafeId<"chatThread">;
  threadWorkspaceId: SafeId<"workspace"> | null;
  userId: SafeId<"user">;
};

export const generateAdmittedThreadTitle = async ({
  generateTextForTask = generateTanStackTextForTask,
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
  generateTextForTask?: typeof generateTanStackTextForTask;
  admissionSignal: AbortSignal;
  modelAdmission: ModelDispatchAdmission;
}): Promise<void> => {
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    usageMetering: {
      actionType: "background",
      organizationId,
      safeDb,
      serviceTier: TITLE_SERVICE_TIER,
      userId,
      workspaceId: threadWorkspaceId,
    },
    feature: "chat.thread_title",
    modelTask: "short-text",
    orgAIConfig,
    modelTier: modelAdmission.modelTier,
    properties: threadWorkspaceId ? { workspace_id: threadWorkspaceId } : {},
    traceId: Bun.randomUUIDv7(),
  });

  // Queued by a raw turn; read again before sending, since the thread may
  // have switched to anonymized mode since.
  const input = await readThreadTitleInput({
    safeDb,
    threadId,
    userId,
    messages,
  });
  if (input.isErr()) {
    observeFailure(input.error, { sink: SEND_MODE_READ_FAILED_SINK });
    return;
  }
  const titleInput = input.value;
  switch (titleInput.type) {
    case "anonymized":
    case "withdrawn":
      return;
    case "available":
      break;
    default:
      titleInput satisfies never;
      return panic("Unhandled title input status");
  }

  const generated = await Result.tryPromise({
    try: async () =>
      await generateArtefact({
        generator: "apps/api/src/handlers/chat/generate-thread-title.ts",
        sources: titleInput.sources,
        generate: async () =>
          cleanGeneratedTitle(
            await generateTextForTask({
              userId,
              dataClass: "customer",
              abortSignal: admissionSignal,
              deadlineMs: TITLE_GENERATION_TIMEOUT_MS,
              finishPolicy: TITLE_FINISH_POLICY,
              maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
              task: "short-text",
              serviceTier: TITLE_SERVICE_TIER,
              orgAIConfig,
              managedAIResidency,
              organizationId,
              admission: modelAdmission,
              analytics: aiAnalytics,
              caching: resolveCaching({
                promptCachingEnabled,
                task: "short-text",
                scopeKey: threadId,
              }),
              tenantWorkspaceIds: threadWorkspaceId ? [threadWorkspaceId] : [],
              prompt: buildThreadTitlePrompt(titleInput.messages),
            }),
          ),
      }),
    catch: (cause) => cause,
  });
  const outcome = Result.flatten(generated);
  if (Result.isError(outcome)) {
    aiAnalytics.captureError(outcome.error);
    if (
      Result.isError(generated) &&
      isUnanticipatedAIFailure(generated.error)
    ) {
      captureError(
        generated.error,
        handlerErrorContext(
          "chat.generateAdmittedThreadTitle.generated_error",
          { threadId },
        ),
      );
    }
    return;
  }
  const artefact = outcome.value;
  const title = projectArtefactText({
    artefact,
    projection: titleInput.projection,
  });
  if (!title) {
    return;
  }

  const updateResult = await safeDb(
    async (tx) =>
      await writeThreadArtefactTitle({
        tx,
        threadId,
        artefact,
        recordAuditEvent,
        expected: { title: initialTitle, source: CHAT_TITLE_SOURCE.DEFAULT },
      }),
  );

  if (Result.isError(updateResult)) {
    captureError(
      updateResult.error,
      handlerErrorContext(
        "chat.generateAdmittedThreadTitle.updateResult_error",
        { threadId },
      ),
    );
    return;
  }

  // Re-index so the new AI-generated title is searchable. Best effort:
  // a failure is reported, never thrown. Awaited, so whoever waits for
  // this title (the turn's follow-ups) waits for its indexing too.
  if (updateResult.value) {
    await indexThread(threadId).catch(
      createErrorCapture(
        handlerErrorContext("generateAdmittedThreadTitle.indexThread"),
      ),
    );
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
    organizationStateDb: props.organizationStateDb,
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
