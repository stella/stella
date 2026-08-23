import { Result } from "better-result";

import type { ReasoningEffort } from "@stll/ai-catalog";

import type { SafeDb } from "@/api/db/safe-db";
import type { UsageEventLane } from "@/api/db/schema";
import {
  compactChatMessagesForModel,
  chatThreadNeedsCompaction,
} from "@/api/handlers/chat/compaction";
import {
  applyChatCompactionCheckpoint,
  readLatestChatCompaction,
} from "@/api/handlers/chat/persistent-compaction";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import type { ChatMessage } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveChatCompactionBudget } from "@/api/lib/chat/compaction-budget";
import { markChatThreadCompactionDue } from "@/api/lib/chat/thread-compaction";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";

type ChatCompactionModelProps = {
  /** Effective chat model override for this turn; see `resolveEffectiveChatModelSelection`. */
  chatModelOverride: string | undefined;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  /** Effective reasoning override paired with the selected thread model. */
  reasoningEffort: ReasoningEffort | undefined;
};

type CompactMessagesForContextProps = ChatCompactionModelProps & {
  abortSignal: AbortSignal;
  boundary: ChatThirdPartyBoundary;
  messages: ChatMessage[];
  safeDb: SafeDb;
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  threadId: SafeId<"chatThread">;
  /** Budget lane of the turn this compaction serves. */
  usageLane: UsageEventLane;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type SelectMessagesForContextInputProps = {
  messages: ChatMessage[];
  safeDb: SafeDb;
  skipCheckpoint: boolean;
  threadId: SafeId<"chatThread">;
};

export const selectMessagesForContextInput = async ({
  messages,
  safeDb,
  skipCheckpoint,
  threadId,
}: SelectMessagesForContextInputProps): Promise<ChatMessage[]> => {
  if (skipCheckpoint) {
    return messages;
  }

  const checkpointResult = await readLatestChatCompaction({
    safeDb,
    threadId,
  });
  if (Result.isError(checkpointResult)) {
    captureError(checkpointResult.error, {
      threadId,
      feature: "chat.compaction_checkpoint_read",
    });
    return messages;
  }

  if (checkpointResult.value === null) {
    return messages;
  }

  return applyChatCompactionCheckpoint({
    checkpoint: checkpointResult.value,
    messages,
  });
};

export const compactMessagesForContext = async ({
  abortSignal,
  boundary,
  chatModelOverride,
  messages,
  organizationId,
  orgAIConfig,
  reasoningEffort,
  safeDb,
  tenantWorkspaceIds,
  threadId,
  usageLane,
  userId,
  workspaceId,
}: CompactMessagesForContextProps): Promise<
  Result<ChatMessage[], HandlerError>
> => {
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "chat",
      // Pre-stream compaction is part of the same interactive turn,
      // so it settles against the turn's resolved lane.
      lane: usageLane,
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId,
    },
    feature: "chat.context_compaction",
    modelRole: "chat",
    orgAIConfig,
    properties: {
      organization_id: organizationId,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    },
    sessionId: threadId,
    traceId: Bun.randomUUIDv7(),
  });

  const { triggerTokens, preserveTokens } = resolveChatCompactionBudget({
    chatModelOverride,
    orgAIConfig,
    organizationId,
  });

  return await compactChatMessagesForModel({
    abortSignal,
    aiAnalytics,
    boundary,
    messages,
    modelId: chatModelOverride,
    tenantWorkspaceIds,
    onSummaryError: (error) => {
      captureError(error, {
        threadId,
        feature: "chat.compaction",
      });
    },
    organizationId,
    orgAIConfig,
    reasoningEffort,
    preserveTokens,
    triggerTokens,
  });
};

type MarkChatCompactionDueProps = ChatCompactionModelProps & {
  messages: ChatMessage[];
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

/**
 * Put the thread on the compaction queue when its window crosses the trigger.
 *
 * The whole of compaction's cost — reading the delta and calling the
 * summarizer — belongs to the scheduler task that drains this queue. All the
 * send path contributes is the token estimate it already has in memory and one
 * indexed update, so a send never waits on a checkpoint and never has to
 * survive one.
 *
 * The mark is idempotent and re-derived on every send, which is what makes it
 * self-healing: if this update is lost, the next send over the trigger stamps
 * the thread again.
 */
export const markChatCompactionDue = async ({
  chatModelOverride,
  messages,
  organizationId,
  orgAIConfig,
  safeDb,
  threadId,
}: MarkChatCompactionDueProps): Promise<void> => {
  const { triggerTokens } = resolveChatCompactionBudget({
    chatModelOverride,
    orgAIConfig,
    organizationId,
  });

  if (!chatThreadNeedsCompaction({ messages, triggerTokens })) {
    return;
  }

  const marked = await safeDb(
    async (tx) => await markChatThreadCompactionDue({ threadId, tx }),
  );
  if (Result.isError(marked)) {
    captureError(marked.error, {
      threadId,
      feature: "chat.compaction_enqueue",
    });
  }
};
