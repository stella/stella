import { generateText } from "ai";

import {
  buildRecapTranscript,
  type RecapMessage,
} from "@/api/handlers/chat/thread-recap-transcript";
import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Bump when the recap prompt or output shape changes so cached
 * recaps with an older version regenerate on the next stale revisit.
 */
export const RECAP_PROMPT_VERSION = 1;

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

const RECAP_MAX_OUTPUT_TOKENS = 256;
const RECAP_GENERATION_TIMEOUT_MS = 20_000;
const RECAP_MAX_LENGTH = 700;

const RECAP_SYSTEM_PROMPT = `You write a brief "where you left off" recap for someone returning to an earlier conversation with a legal assistant after a break.

Write 2 to 4 sentences of plain prose: no markdown, no headings, no bullet points, no greeting. First state what was discussed or accomplished, then what still remains open — unanswered questions, next steps, or unfinished work. If nothing remains open, only summarise what was covered.

Write in the same language as the conversation. Be specific: name the actual topics, documents, and decisions rather than describing the conversation in the abstract. You may address the reader directly ("You were…"), but never write in the assistant's first person ("I…") and do not describe the assistant as a person. Do not invent anything that is not in the transcript. Reply with the recap text only.`;

/** Whether the latest message is old enough to count as a revisit. */
export const isThreadStaleForRecap = (lastMessageCreatedAt: Date): boolean =>
  Date.now() - lastMessageCreatedAt.getTime() > RECAP_STALENESS_THRESHOLD_MS;

const stripRecapPrefix = (value: string): string => {
  const prefix = "recap:";
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) {
    return value;
  }

  return value.slice(prefix.length).trimStart();
};

const isWrappingQuote = (char: string): boolean => char === '"' || char === "'";

const trimWrappingQuotes = (value: string): string => {
  let start = 0;
  let end = value.length;

  while (start < end && isWrappingQuote(value.charAt(start))) {
    start += 1;
  }
  while (end > start && isWrappingQuote(value.charAt(end - 1))) {
    end -= 1;
  }

  return value.slice(start, end);
};

const cleanRecapText = (text: string): string | null => {
  const withoutLabel = stripRecapPrefix(text.trim());
  const unquoted = trimWrappingQuotes(withoutLabel).trim();
  const capped = unquoted.slice(0, RECAP_MAX_LENGTH).trim();
  return capped.length > 0 ? capped : null;
};

type GenerateThreadRecapTextArgs = {
  messages: readonly RecapMessage[];
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
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
  messages,
  organizationId,
  orgAIConfig,
  promptCachingEnabled,
  threadId,
  workspaceId,
}: GenerateThreadRecapTextArgs): Promise<string | null> => {
  const transcript = buildRecapTranscript(messages);
  if (!transcript) {
    return null;
  }

  const aiAnalytics = createAIAnalyticsCallbacks({
    feature: "chat.thread_recap",
    modelRole: "fast",
    orgAIConfig,
    properties: workspaceId ? { workspace_id: workspaceId } : {},
    traceId: Bun.randomUUIDv7(),
  });

  try {
    const { text } = await generateText({
      abortSignal: AbortSignal.timeout(RECAP_GENERATION_TIMEOUT_MS),
      maxOutputTokens: RECAP_MAX_OUTPUT_TOKENS,
      model: getModelForRole("fast", orgAIConfig, {
        promptCachingEnabled,
        scopeKey: threadId,
        organizationId,
      }),
      prompt: `Conversation transcript:\n\n${transcript}\n\nRecap:`,
      system: RECAP_SYSTEM_PROMPT,
      temperature: 0,
      ...aiAnalytics.stepCallbacks,
    });

    return cleanRecapText(text);
  } catch (error) {
    aiAnalytics.captureError(error);
    captureError(error, { threadId, feature: "chat.thread_recap" });
    return null;
  }
};
