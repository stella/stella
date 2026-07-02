import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import type { SafeDb, SafeDbError, Transaction } from "@/api/db";
import {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import {
  CHAT_COMPACTION_PROMPT_VERSION,
  createCompactionSummaryMessage,
  summarizeChatCompactionForModel,
} from "@/api/handlers/chat/compaction";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import type {
  ChatCompactionSummary,
  ChatMessage,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
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

type ShouldInvalidateChatCompactionCheckpointProps = {
  deletedMessageCount: number;
  persistencePlan: Pick<MessagePersistencePlan, "type">;
};

export const shouldInvalidateChatCompactionCheckpoint = ({
  deletedMessageCount,
  persistencePlan,
}: ShouldInvalidateChatCompactionCheckpointProps): boolean => {
  if (deletedMessageCount > 0) {
    return true;
  }

  switch (persistencePlan.type) {
    case "update":
    case "replace-last-assistant":
      return true;
    case "insert":
    case "none":
      return false;
    default: {
      const exhaustive: never = persistencePlan.type;
      return exhaustive;
    }
  }
};

type MarkActiveChatCompactionCheckpointStaleProps = {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

export const markActiveChatCompactionCheckpointStale = async ({
  threadId,
  tx,
}: MarkActiveChatCompactionCheckpointStaleProps): Promise<void> => {
  // audit: skip - derived compaction checkpoint cache; no user-authored state change
  await tx
    .update(chatThreadCompactions)
    .set({ status: "stale" })
    .where(
      and(
        eq(chatThreadCompactions.threadId, threadId),
        eq(chatThreadCompactions.status, "active"),
      ),
    );
};

type PersistChatCompactionCheckpointProps = {
  abortSignal: AbortSignal;
  boundary: ChatThirdPartyBoundary;
  dataWorkspaceIds: readonly SafeId<"workspace">[];
  messages: ChatMessage[];
  modelId?: string | undefined;
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

export const persistChatCompactionCheckpoint = async ({
  abortSignal,
  boundary,
  dataWorkspaceIds,
  messages,
  modelId,
  onSummaryError,
  organizationId,
  orgAIConfig,
  safeDb,
  threadId,
}: PersistChatCompactionCheckpointProps): Promise<
  Result<void, HandlerError<422 | 500> | SafeDbError>
> => {
  const checkpointResult = await summarizeChatCompactionForModel({
    abortSignal,
    boundary,
    messages,
    modelId,
    onSummaryError,
    organizationId,
    orgAIConfig,
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
    await lockChatThreadForCompaction({ threadId, tx });

    const snapshotIsCurrent = await isChatCompactionSnapshotCurrent({
      dataWorkspaceIds,
      messages,
      threadId,
      tx,
    });
    if (!snapshotIsCurrent) {
      return;
    }

    await markActiveChatCompactionCheckpointStale({ threadId, tx });

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

const lockChatThreadForCompaction = async ({
  threadId,
  tx,
}: {
  threadId: SafeId<"chatThread">;
  tx: Transaction;
}): Promise<void> => {
  await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .for("update");
};

type ChatCompactionSnapshotMessageRow = {
  id: SafeId<"chatMessage">;
  role: ChatMessage["role"];
  content: PersistedChatMessageContent;
};

type IsChatCompactionSnapshotCurrentProps = {
  dataWorkspaceIds: readonly SafeId<"workspace">[];
  messages: readonly ChatMessage[];
  threadId: SafeId<"chatThread">;
  tx: Transaction;
};

const isChatCompactionSnapshotCurrent = async ({
  dataWorkspaceIds,
  messages,
  threadId,
  tx,
}: IsChatCompactionSnapshotCurrentProps): Promise<boolean> => {
  const firstSnapshotMessage = messages.at(0);
  if (!firstSnapshotMessage) {
    return false;
  }

  const thread = await tx.query.chatThreads.findFirst({
    where: { id: { eq: threadId } },
    columns: { dataWorkspaceIds: true },
  });
  if (
    !thread ||
    !workspaceIdsEqual(thread.dataWorkspaceIds, dataWorkspaceIds)
  ) {
    return false;
  }

  const firstPersistedMessage = await tx.query.chatMessages.findFirst({
    where: {
      id: { eq: brandPersistedChatMessageId(firstSnapshotMessage.id) },
      threadId: { eq: threadId },
    },
    columns: { createdAt: true, id: true },
  });
  if (!firstPersistedMessage) {
    return false;
  }

  const rows = await tx
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        sql`(${chatMessages.createdAt}, ${chatMessages.id}) >= (${firstPersistedMessage.createdAt}, ${firstPersistedMessage.id})`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(messages.length + 1);

  return chatCompactionSnapshotMessagesEqual(rows, messages);
};

export const chatCompactionSnapshotMessagesEqual = (
  rows: readonly ChatCompactionSnapshotMessageRow[],
  messages: readonly ChatMessage[],
): boolean => {
  if (rows.length !== messages.length) {
    return false;
  }

  return rows.every((row, index) => {
    const message = messages.at(index);
    if (!message) {
      return false;
    }

    return (
      row.id === message.id &&
      row.role === message.role &&
      jsonEqual(
        normalizePersistedChatMessageContent(row.content).parts,
        message.parts,
      )
    );
  });
};

const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    if (left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => jsonEqual(item, right.at(index)));
  }

  if (!isJsonRecord(left) || !isJsonRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]),
  );
};

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const workspaceIdsEqual = (
  left: readonly SafeId<"workspace">[],
  right: readonly SafeId<"workspace">[],
): boolean => {
  const leftIds = new Set(left);
  const rightIds = new Set(right);

  if (leftIds.size !== rightIds.size) {
    return false;
  }

  for (const id of leftIds) {
    if (!rightIds.has(id)) {
      return false;
    }
  }
  return true;
};
