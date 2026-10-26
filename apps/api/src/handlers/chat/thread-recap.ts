import { Temporal } from "@stll/time";

import { cleanRecapText } from "@/api/handlers/chat/thread-recap-text";
import {
  buildRecapTranscript,
  type RecapMessage,
} from "@/api/handlers/chat/thread-recap-transcript";
import { type OrgAIConfig, resolveCaching } from "@/api/lib/ai-config";
import { isUnanticipatedAIFailure } from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";

/**
 * Bump when the recap prompt or output shape changes so cached
 * recaps with an older version regenerate on the next stale revisit.
 */
export const RECAP_PROMPT_VERSION = 2;

/**
 * A thread counts as a "revisit" worth recapping once its latest
 * message is at least this old. Kept loosely in sync with the
 * frontend gate in chat-thread-recap.tsx; the server re-checks here
 * so a stale or spoofed client request never spends a model call on a
 * fresh thread.
 */
const RECAP_STALENESS_THRESHOLD_MS = 4 * 60 * 60 * 1000;

/** Minimum messages before a thread has enough to recap. */
export const RECAP_MIN_MESSAGE_COUNT = 2;

// Room for four sentences in languages that tokenize densely, such as Czech
// with statute citations; a run that still hits it is rejected, not shown cut.
const RECAP_MAX_OUTPUT_TOKENS = 512;
const RECAP_GENERATION_TIMEOUT_MS = 20_000;

const RECAP_SYSTEM_PROMPT = `You write a brief "where you left off" recap for someone returning to an earlier conversation with a legal assistant after a break.

Write 2 to 4 sentences of plain prose: no markdown, no headings, no bullet points, no greeting. First state what was discussed or accomplished, then what still remains open: unanswered questions, next steps, or unfinished work. If nothing remains open, only summarise what was covered.

Write in the language the user writes their messages in, even when the transcript labels, these instructions, cited titles or notes in parentheses are in English. Never switch to English for a conversation held in another language. Be specific: name the actual topics, documents, and decisions rather than describing the conversation in the abstract. You may address the reader in the second person, but never write in the assistant's first person and do not describe the assistant as a person. Do not invent anything that is not in the transcript. Reply with the recap text only.`;

/** Whether the latest message is old enough to count as a revisit. */
export const isThreadStaleForRecap = (lastMessageCreatedAt: Date): boolean =>
  Temporal.Now.instant().epochMilliseconds - lastMessageCreatedAt.getTime() >
  RECAP_STALENESS_THRESHOLD_MS;

type GenerateThreadRecapTextArgs = {
  admission: ModelDispatchAdmission;
  messages: readonly RecapMessage[];
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  promptCachingEnabled: boolean;
  threadId: SafeId<"chatThread">;
  workspaceId: SafeId<"workspace"> | null;
};

/**
 * Generate a recap from the thread transcript. Returns null (never
 * throws) when there is nothing to summarise or the model call fails:
 * the recap is a non-critical nicety, so a failure surfaces no recap
 * rather than an error.
 */
export const generateThreadRecapText = async ({
  admission,
  messages,
  organizationId,
  orgAIConfig,
  managedAIResidency,
  promptCachingEnabled,
  threadId,
  workspaceId,
}: GenerateThreadRecapTextArgs): Promise<string | null> => {
  const transcript = buildRecapTranscript(messages);
  if (!transcript) {
    return null;
  }

  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    feature: "chat.thread_recap",
    modelTask: "short-text",
    orgAIConfig,
    modelTier: admission.modelTier,
    properties: workspaceId ? { workspace_id: workspaceId } : {},
    traceId: Bun.randomUUIDv7(),
  });

  try {
    const text = await generateTanStackTextForTask({
      userId: admission.userId,
      dataClass: "customer",
      deadlineMs: RECAP_GENERATION_TIMEOUT_MS,
      finishPolicy: "require-complete",
      maxOutputTokens: RECAP_MAX_OUTPUT_TOKENS,
      task: "short-text",
      serviceTier: "standard",
      orgAIConfig,
      managedAIResidency,
      organizationId,
      admission,
      analytics: aiAnalytics,
      caching: resolveCaching({
        promptCachingEnabled,
        task: "short-text",
        scopeKey: threadId,
      }),
      tenantWorkspaceIds: workspaceId ? [workspaceId] : [],
      prompt: `Conversation transcript:\n\n${transcript}\n\nRecap:`,
      system: RECAP_SYSTEM_PROMPT,
      systemPromptOrigin: "server-built",
    });

    return cleanRecapText(text);
  } catch (error) {
    aiAnalytics.captureError(error);
    if (isUnanticipatedAIFailure(error)) {
      captureError(
        error,
        handlerErrorContext("chat.generateThreadRecapText", {
          threadId,
          feature: "chat.thread_recap",
        }),
      );
    }
    return null;
  }
};
