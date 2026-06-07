import type { LanguageModel } from "ai";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { chatThreadCompactions } from "@/api/db/schema";
import {
  CHAT_COMPACTION_PROMPT_VERSION,
  createCompactionSummaryMessage,
  summarizeChatCompactionForModel,
} from "@/api/handlers/chat/compaction";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import type {
  ChatCompactionSummary,
  ChatMessage,
} from "@/api/handlers/chat/types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

export type ChatThreadCompactionCheckpoint = {
  firstKeptMessageId: SafeId<"chatMessage">;
  id: SafeId<"chatThreadCompaction">;
  summarizedMessageCount: number;
  summary: ChatCompactionSummary;
  summaryMarkdown: string;
};

type ReadLatestChatCompactionProps = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

export const readLatestChatCompaction = async ({
  safeDb,
  threadId,
}: ReadLatestChatCompactionProps): Promise<
  Result<ChatThreadCompactionCheckpoint | null, SafeDbError>
> => {
  const result = await safeDb((tx) =>
    tx.query.chatThreadCompactions.findFirst({
      where: {
        threadId: { eq: threadId },
        status: { eq: "active" },
      },
      columns: {
        id: true,
        firstKeptMessageId: true,
        summarizedMessageCount: true,
        summary: true,
        summaryMarkdown: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );
  if (Result.isError(result)) {
    return Result.err(result.error);
  }

  return Result.ok(result.value ?? null);
};

type ApplyChatCompactionCheckpointProps = {
  checkpoint: ChatThreadCompactionCheckpoint;
  messages: ChatMessage[];
};

export const applyChatCompactionCheckpoint = ({
  checkpoint,
  messages,
}: ApplyChatCompactionCheckpointProps): ChatMessage[] | null => {
  const firstKeptIndex = messages.findIndex(
    (message) => message.id === checkpoint.firstKeptMessageId,
  );
  if (firstKeptIndex === -1) {
    return null;
  }

  return [
    createCompactionSummaryMessage({
      summarizedMessageCount: checkpoint.summarizedMessageCount,
      summary: checkpoint.summaryMarkdown,
    }),
    ...messages.slice(firstKeptIndex),
  ];
};

type PersistChatCompactionCheckpointProps = {
  abortSignal: AbortSignal;
  boundary: ChatThirdPartyBoundary;
  messages: ChatMessage[];
  model: LanguageModel;
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

export const persistChatCompactionCheckpoint = async ({
  abortSignal,
  boundary,
  messages,
  model,
  onSummaryError,
  safeDb,
  threadId,
}: PersistChatCompactionCheckpointProps): Promise<
  Result<void, HandlerError<422 | 500> | SafeDbError>
> => {
  const checkpointResult = await summarizeChatCompactionForModel({
    abortSignal,
    boundary,
    messages,
    model,
    onSummaryError,
  });
  if (Result.isError(checkpointResult)) {
    return Result.err(checkpointResult.error);
  }
  const checkpoint = checkpointResult.value;
  if (checkpoint === null) {
    return Result.ok();
  }

  const firstSummarizedMessage = checkpoint.plan.messagesToSummarize.at(0)?.id;
  const lastSummarizedMessage = checkpoint.plan.messagesToSummarize.at(-1)?.id;
  const firstKeptMessage = checkpoint.plan.recentMessages.at(0)?.id;
  if (!firstSummarizedMessage || !lastSummarizedMessage || !firstKeptMessage) {
    return Result.ok();
  }

  const persistResult = await safeDb(async (tx) => {
    // audit: skip — derived compaction checkpoint cache; no user-authored state change
    await tx
      .update(chatThreadCompactions)
      .set({ status: "stale" })
      .where(
        and(
          eq(chatThreadCompactions.threadId, threadId),
          eq(chatThreadCompactions.status, "active"),
        ),
      );

    // audit: skip — derived compaction checkpoint cache; no user-authored state change
    await tx.insert(chatThreadCompactions).values({
      id: createSafeId<"chatThreadCompaction">(),
      threadId,
      status: "active",
      summary: checkpoint.summary,
      summaryMarkdown: checkpoint.summaryMarkdown,
      firstSummarizedMessageId: brandPersistedChatMessageId(
        firstSummarizedMessage,
      ),
      lastSummarizedMessageId: brandPersistedChatMessageId(
        lastSummarizedMessage,
      ),
      firstKeptMessageId: brandPersistedChatMessageId(firstKeptMessage),
      summarizedMessageCount: checkpoint.plan.messagesToSummarize.length,
      totalTokens: checkpoint.plan.totalTokens,
      preservedTokens: checkpoint.plan.preservedTokens,
      promptVersion: CHAT_COMPACTION_PROMPT_VERSION,
    });
  });

  return persistResult.andThen(() => Result.ok());
};
