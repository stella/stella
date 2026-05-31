import { generateText } from "ai";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { chatThreads } from "@/api/db/schema";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { getModelForRole } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

const TITLE_MAX_LENGTH = 60;
const TITLE_CONTEXT_MAX_LENGTH = 500;
const TITLE_MAX_OUTPUT_TOKENS = 32;
const TITLE_GENERATION_TIMEOUT_MS = 10_000;

type GenerateThreadTitleProps = {
  messages: [ChatMessage, ChatMessage]; // [userMessage, AIMessage]
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  threadWorkspaceId: SafeId<"workspace"> | null;
};

export const generateThreadTitle = async ({
  messages,
  organizationId,
  orgAIConfig,
  promptCachingEnabled,
  recordAuditEvent,
  safeDb,
  threadId,
  threadWorkspaceId,
}: GenerateThreadTitleProps): Promise<void> => {
  const aiAnalytics = createAIAnalyticsCallbacks({
    feature: "chat.thread_title",
    modelRole: "fast",
    orgAIConfig,
    properties: threadWorkspaceId ? { workspace_id: threadWorkspaceId } : {},
    traceId: Bun.randomUUIDv7(),
  });

  try {
    const [userMessage, assistantMessage] = messages;
    const userText = extractTitleContext(userMessage);
    const assistantText = extractTitleContext(assistantMessage);

    const { text } = await generateText({
      abortSignal: AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS),
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      model: getModelForRole("fast", orgAIConfig, {
        promptCachingEnabled,
        scopeKey: threadId,
        organizationId,
      }),
      prompt: `Given this conversation, reply with a short thread title (max 6 words). Reply with the title only, nothing else.

User: ${userText}
Assistant: ${assistantText}`,
      ...aiAnalytics.stepCallbacks,
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

      if (!currentThread || currentThread.titleSource !== "user") {
        return;
      }

      const updatedRows = await tx
        .update(chatThreads)
        .set({ title, titleSource: "ai" })
        .where(
          and(
            eq(chatThreads.id, threadId),
            eq(chatThreads.titleSource, "user"),
          ),
        )
        .returning({ id: chatThreads.id });

      if (updatedRows.length === 0) {
        return;
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
        resourceId: threadId,
        workspaceId: threadWorkspaceId,
        changes: {
          title: { old: currentThread.title, new: title },
          titleSource: { old: currentThread.titleSource, new: "ai" },
        },
      });
    });

    if (Result.isError(updateResult)) {
      captureError(updateResult.error, { threadId });
    }
  } catch (error) {
    aiAnalytics.captureError(error);
    captureError(error, { threadId });
  }
};

const extractTitleContext = (message: ChatMessage): string =>
  message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, TITLE_CONTEXT_MAX_LENGTH);

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

const stripTitlePrefix = (value: string): string => {
  const prefix = "title:";
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) {
    return value;
  }

  return value.slice(prefix.length).trimStart();
};

const stripTitleWrapper = (value: string): string => {
  const unquoted = trimWrappingQuotes(value.trim()).trim();
  return trimWrappingQuotes(stripTitlePrefix(unquoted).trim()).trim();
};

const cleanGeneratedTitle = (text: string): string =>
  stripTitleWrapper(text).slice(0, TITLE_MAX_LENGTH);
