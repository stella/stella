import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";

import type { ModelRole, ReasoningEffort } from "@stll/ai-catalog";

import {
  getChatAttachmentFilename,
  getChatAttachmentMimeType,
  isChatAttachmentPart,
  isChatTextPart,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { prepareTextForThirdParty } from "@/api/handlers/chat/third-party-boundary";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CHAT_COMPACTION_SYSTEM_PROMPT,
  COMPACTION_SYSTEM_PROMPT,
} from "@/api/lib/chat/compaction-summary";
import {
  DEFAULT_PRESERVE_TOKENS,
  DEFAULT_TRIGGER_TOKENS,
  COMPACTION_GENERATION_POLICY,
  estimateTextTokens,
  FILE_PART_ESTIMATED_TOKENS,
  MAX_STRUCTURED_PART_CHARS,
  MAX_TEXT_PART_CHARS,
  MESSAGE_OVERHEAD_TOKENS,
  renderTaggedValue,
  safeStringify,
  truncateForCompaction,
} from "@/api/lib/chat/compaction-tokens";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

export const COMPACTION_SUMMARY_MESSAGE_ID = "stella-chat-compaction-summary";

type TanStackCompactionAIAnalytics = Pick<
  TanStackAIAnalyticsCallbacks,
  "captureError" | "middleware"
>;

export type ChatCompactionPlan =
  | {
      totalTokens: number;
      type: "none";
    }
  | {
      messagesToSummarize: ChatMessage[];
      preservedTokens: number;
      recentMessages: ChatMessage[];
      totalTokens: number;
      type: "compact";
    };

type ModelCompactionPlan =
  | {
      totalTokens: number;
      type: "none";
    }
  | {
      messagesToSummarize: ModelMessage[];
      preservedTokens: number;
      recentMessages: ModelMessage[];
      totalTokens: number;
      type: "compact";
    };

type PlanChatCompactionOptions = {
  messages: ChatMessage[];
  preserveTokens?: number | undefined;
  triggerTokens?: number | undefined;
};

/**
 * Cheap pre-check for the checkpoint writer: does the estimated token total
 * cross the compaction trigger? Pure token arithmetic, no LLM/summarize call,
 * so the common (under-trigger) send path never reads the full thread history.
 * Mirrors the `totalTokens > triggerTokens` gate inside `planChatCompaction`.
 */
export const shouldCompactChatMessages = (
  messages: readonly ChatMessage[],
  triggerTokens: number = DEFAULT_TRIGGER_TOKENS,
): boolean => estimateMessagesTokens(messages) > triggerTokens;

type ChatThreadNeedsCompactionOptions = {
  /** The post-checkpoint history window, as loaded for this send. */
  messages: readonly ChatMessage[];
  triggerTokens?: number | undefined;
};

/**
 * Whether a send should put its thread on the compaction queue.
 *
 * Two independent signals, because the token estimate alone is measured over a
 * window that is itself capped. A thread of short messages keeps every capped
 * slice under the token trigger no matter how long it grows, while everything
 * past the cap has already fallen out of model context: the exact state
 * compaction exists to prevent, and one no token gate over that slice can
 * report. A full window is the durable evidence of that backlog: the loader
 * returns at most `chatSendHistoryWindowMax` rows after the checkpoint cursor,
 * so reaching the cap means unsummarized messages exist beyond it.
 *
 * Enqueuing on a full window that turns out to be exactly the cap costs one
 * bounded run that settles as up-to-date, which is far cheaper than a thread
 * that can never be compacted at all.
 */
export const chatThreadNeedsCompaction = ({
  messages,
  triggerTokens,
}: ChatThreadNeedsCompactionOptions): boolean =>
  messages.length >= LIMITS.chatSendHistoryWindowMax ||
  shouldCompactChatMessages(messages, triggerTokens);

export type ThreadContextUsage = {
  estimatedTokens: number;
  triggerTokens: number;
  /** Prompt-cache-stable prefix (instructions + tool catalog). Equal to
   *  `breakdown.promptTokens + breakdown.toolTokens`. */
  cacheStableTokens: number;
  /** Messages folded into the active checkpoint summary; 0 when none. */
  summarizedMessageCount: number;
  /** Five parts in legend/render order. They sum to `estimatedTokens`
   *  exactly, so the segmented bar needs no reconciliation. */
  breakdown: {
    promptTokens: number;
    toolTokens: number;
    summaryTokens: number;
    attachmentTokens: number;
    conversationTokens: number;
  };
};

type ComputeThreadContextUsageOptions = {
  messages: readonly ChatMessage[];
  /** Active compaction checkpoint carried into the next send, or null when the
   *  thread has not been summarized yet. Its rendered summary message is what
   *  the model actually receives, so it is estimated the same way here. */
  summary: {
    summarizedMessageCount: number;
    summaryMarkdown: string;
  } | null;
  /** System-prompt estimate (core rules + skill catalog). Supplied by the
   *  caller from the shared prompt builders; defaults to 0 for pure
   *  token-math callers/tests. */
  promptTokens?: number | undefined;
  /** Tool-catalog estimate (the read.* API surface in the system prompt).
   *  Supplied by the caller; defaults to 0. */
  toolTokens?: number | undefined;
  triggerTokens?: number | undefined;
};

/**
 * Estimate the model context a thread's next send would carry, split into the
 * five parts the composer meter renders: the cache-stable prefix (system
 * prompt + tool catalog), the active compaction summary, the attachment file
 * parts, and the conversation text. The message-derived parts reuse the same
 * estimators as `planChatCompaction`, so the conversation/summary/attachment
 * split tracks what `shouldCompactChatMessages` sees; the five parts sum to
 * `estimatedTokens` exactly.
 */
export const computeThreadContextUsage = ({
  messages,
  summary,
  promptTokens = 0,
  toolTokens = 0,
  triggerTokens = DEFAULT_TRIGGER_TOKENS,
}: ComputeThreadContextUsageOptions): ThreadContextUsage => {
  const summaryTokens = summary
    ? estimateMessageTokens(
        createCompactionSummaryMessage({
          summarizedMessageCount: summary.summarizedMessageCount,
          summary: summary.summaryMarkdown,
        }),
      )
    : 0;

  let conversationTokens = 0;
  let attachmentTokens = 0;
  for (const message of messages) {
    const messageAttachmentTokens =
      countAttachmentParts(message) * FILE_PART_ESTIMATED_TOKENS;
    attachmentTokens += messageAttachmentTokens;
    // The message's non-attachment share (overhead + text/structured parts) is
    // whatever estimateMessageTokens counts beyond its file parts, so the split
    // stays exact against the estimator the send path uses.
    conversationTokens +=
      estimateMessageTokens(message) - messageAttachmentTokens;
  }

  return {
    estimatedTokens:
      promptTokens +
      toolTokens +
      summaryTokens +
      attachmentTokens +
      conversationTokens,
    triggerTokens,
    cacheStableTokens: promptTokens + toolTokens,
    summarizedMessageCount: summary?.summarizedMessageCount ?? 0,
    breakdown: {
      promptTokens,
      toolTokens,
      summaryTokens,
      attachmentTokens,
      conversationTokens,
    },
  };
};

const countAttachmentParts = (message: ChatMessage): number =>
  message.parts.filter(isChatAttachmentPart).length;

export const planChatCompaction = ({
  messages,
  preserveTokens = DEFAULT_PRESERVE_TOKENS,
  triggerTokens = DEFAULT_TRIGGER_TOKENS,
}: PlanChatCompactionOptions): ChatCompactionPlan => {
  const providerVisibleMessages = getProviderVisibleMessages(messages);
  const totalTokens = estimateMessagesTokens(providerVisibleMessages);
  if (totalTokens <= triggerTokens) {
    return { totalTokens, type: "none" };
  }

  const recentMessages: ChatMessage[] = [];
  let preservedTokens = 0;

  for (let index = providerVisibleMessages.length - 1; index >= 0; index -= 1) {
    const message = providerVisibleMessages.at(index);
    if (!message) {
      continue;
    }

    const messageTokens = estimateMessageTokens(message);
    if (
      recentMessages.length > 0 &&
      preservedTokens + messageTokens > preserveTokens &&
      startsWithUserMessage(recentMessages)
    ) {
      break;
    }

    preservedTokens += messageTokens;
    recentMessages.unshift(message);
  }

  const messagesToSummarize = providerVisibleMessages.slice(
    0,
    providerVisibleMessages.length - recentMessages.length,
  );
  if (messagesToSummarize.length === 0) {
    return { totalTokens, type: "none" };
  }

  return {
    messagesToSummarize,
    preservedTokens,
    recentMessages,
    totalTokens,
    type: "compact",
  };
};

export const planModelCompaction = ({
  messages,
  preserveTokens = DEFAULT_PRESERVE_TOKENS,
  triggerTokens = DEFAULT_TRIGGER_TOKENS,
}: {
  messages: ModelMessage[];
  preserveTokens?: number | undefined;
  triggerTokens?: number | undefined;
}): ModelCompactionPlan => {
  const totalTokens = estimateModelMessagesTokens(messages);
  if (totalTokens <= triggerTokens) {
    return { totalTokens, type: "none" };
  }

  const recentMessages: ModelMessage[] = [];
  let preservedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages.at(index);
    if (!message) {
      continue;
    }

    const messageTokens = estimateModelMessageTokens(message);
    if (
      recentMessages.length > 0 &&
      preservedTokens + messageTokens > preserveTokens &&
      startsWithUserMessage(recentMessages)
    ) {
      break;
    }

    preservedTokens += messageTokens;
    recentMessages.unshift(message);
  }

  const messagesToSummarize = messages.slice(
    0,
    messages.length - recentMessages.length,
  );
  if (messagesToSummarize.length === 0) {
    return { totalTokens, type: "none" };
  }

  return {
    messagesToSummarize,
    preservedTokens,
    recentMessages,
    totalTokens,
    type: "compact",
  };
};

type CompactChatMessagesOptions = PlanChatCompactionOptions & {
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
  prepareTranscript?:
    | ((transcript: string) => Promise<Result<string, HandlerError<422 | 500>>>)
    | undefined;
  summarizeTranscript: (transcript: string) => Promise<string>;
};

type CompactModelMessagesOptions = {
  messages: ModelMessage[];
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
  preserveTokens?: number | undefined;
  summarizeTranscript: (transcript: string) => Promise<string>;
  triggerTokens?: number | undefined;
};
export const compactChatMessages = async ({
  messages,
  onSummaryError,
  prepareTranscript,
  preserveTokens,
  summarizeTranscript,
  triggerTokens,
}: CompactChatMessagesOptions): Promise<
  Result<ChatMessage[], HandlerError<422 | 500>>
> => {
  const plan = planChatCompaction({ messages, preserveTokens, triggerTokens });
  if (plan.type === "none") {
    return Result.ok(messages);
  }

  const transcript = renderChatMessagesForCompaction(plan.messagesToSummarize);
  const preparedTranscript = prepareTranscript
    ? await prepareTranscript(transcript)
    : Result.ok(transcript);
  if (Result.isError(preparedTranscript)) {
    return Result.err(preparedTranscript.error);
  }

  const summaryResult = await Result.tryPromise({
    try: async () => await summarizeTranscript(preparedTranscript.value),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to compact chat history",
        cause,
      }),
  });
  if (Result.isError(summaryResult)) {
    onSummaryError?.(summaryResult.error);
    return Result.ok(plan.recentMessages);
  }

  const summaryMarkdown = summaryResult.value.trim();
  if (summaryMarkdown.length === 0) {
    return Result.ok(plan.recentMessages);
  }

  return Result.ok([
    createCompactionSummaryMessage({
      summarizedMessageCount: plan.messagesToSummarize.length,
      summary: summaryMarkdown,
    }),
    ...plan.recentMessages,
  ]);
};

export const compactModelMessages = async ({
  messages,
  onSummaryError,
  preserveTokens,
  summarizeTranscript,
  triggerTokens,
}: CompactModelMessagesOptions): Promise<
  Result<ModelMessage[], HandlerError<500>>
> => {
  const plan = planModelCompaction({ messages, preserveTokens, triggerTokens });
  if (plan.type === "none") {
    return Result.ok(messages);
  }

  const transcript = renderModelMessagesForCompaction(plan.messagesToSummarize);
  const summaryResult = await Result.tryPromise({
    try: async () => await summarizeTranscript(transcript),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to compact model step history",
        cause,
      }),
  });
  if (Result.isError(summaryResult)) {
    onSummaryError?.(summaryResult.error);
    return Result.ok(plan.recentMessages);
  }

  const summary = summaryResult.value.trim();
  if (summary.length === 0) {
    return Result.ok(plan.recentMessages);
  }

  return Result.ok([
    createModelCompactionSummaryMessage({
      summarizedMessageCount: plan.messagesToSummarize.length,
      summary,
    }),
    ...plan.recentMessages,
  ]);
};

type CompactChatMessagesForModelOptions = PlanChatCompactionOptions & {
  abortSignal: AbortSignal;
  aiAnalytics?: TanStackCompactionAIAnalytics | undefined;
  boundary: ChatThirdPartyBoundary;
  modelId?: string | undefined;
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  reasoningEffort?: ReasoningEffort | undefined;
  /** Tenant set for the model-ingress guard on the summarizer request. */
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
};

type CompactModelMessagesForModelOptions = {
  abortSignal: AbortSignal;
  aiAnalytics?: TanStackCompactionAIAnalytics | undefined;
  modelId?: string | undefined;
  messages: ModelMessage[];
  onSummaryError?: ((error: HandlerError<500>) => void) | undefined;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  preserveTokens?: number | undefined;
  role: ModelRole;
  summarizeWithModel?: ((transcript: string) => Promise<string>) | undefined;
  /** Tenant set for the model-ingress guard on the summarizer request. */
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  triggerTokens?: number | undefined;
};

export const compactChatMessagesForModel = async ({
  abortSignal,
  aiAnalytics,
  boundary,
  messages,
  modelId,
  onSummaryError,
  organizationId,
  orgAIConfig,
  reasoningEffort,
  preserveTokens,
  tenantWorkspaceIds,
  triggerTokens,
}: CompactChatMessagesForModelOptions): Promise<
  Result<ChatMessage[], HandlerError<422 | 500>>
> =>
  await compactChatMessages({
    messages,
    onSummaryError,
    preserveTokens,
    triggerTokens,
    prepareTranscript: async (transcript) =>
      await prepareTextForThirdParty({ boundary, text: transcript }),
    summarizeTranscript: async (transcript) => {
      const result = await Result.tryPromise({
        try: async () =>
          await generateTanStackTextForRole({
            abortSignal,
            analytics: aiAnalytics,
            caching: resolveCaching({
              promptCachingEnabled: false,
              role: "chat",
              scopeKey: null,
            }),
            ...COMPACTION_GENERATION_POLICY,
            modelId,
            organizationId,
            orgAIConfig,
            reasoningEffort,
            prompt: [
              "Compact the earlier conversation transcript below.",
              "Return only the checkpoint summary.",
              "",
              transcript,
            ].join("\n"),
            role: "chat",
            serviceTier: "standard",
            system: CHAT_COMPACTION_SYSTEM_PROMPT,
            systemPromptOrigin: "server-built",
            temperature: 0,
            tenantWorkspaceIds,
          }),
        catch: (error) => {
          aiAnalytics?.captureError(error);
          return error;
        },
      });
      if (Result.isError(result)) {
        throw result.error;
      }

      return result.value;
    },
  });

export const compactModelMessagesForModel = async ({
  abortSignal,
  aiAnalytics,
  modelId,
  messages,
  onSummaryError,
  organizationId,
  orgAIConfig,
  preserveTokens,
  role,
  summarizeWithModel,
  tenantWorkspaceIds,
  triggerTokens,
}: CompactModelMessagesForModelOptions): Promise<
  Result<ModelMessage[], HandlerError<500>>
> =>
  await compactModelMessages({
    messages,
    onSummaryError,
    preserveTokens,
    summarizeTranscript: async (transcript) => {
      if (summarizeWithModel) {
        return await summarizeWithModel(transcript);
      }

      const result = await Result.tryPromise({
        try: async () =>
          await generateTanStackTextForRole({
            abortSignal,
            analytics: aiAnalytics,
            caching: resolveCaching({
              promptCachingEnabled: false,
              role,
              scopeKey: null,
            }),
            ...COMPACTION_GENERATION_POLICY,
            modelId,
            organizationId,
            orgAIConfig,
            prompt: [
              "Compact the earlier model-step transcript below.",
              "Return only the checkpoint summary.",
              "",
              transcript,
            ].join("\n"),
            system: COMPACTION_SYSTEM_PROMPT,
            systemPromptOrigin: "server-built",
            role,
            serviceTier: "standard",
            temperature: 0,
            tenantWorkspaceIds,
          }),
        catch: (error) => {
          aiAnalytics?.captureError(error);
          return error;
        },
      });
      if (Result.isError(result)) {
        throw result.error;
      }

      return result.value;
    },
    triggerTokens,
  });

export const renderChatMessagesForCompaction = (
  messages: readonly ChatMessage[],
): string => {
  const renderedMessages: string[] = [];

  for (const message of messages) {
    const visibleParts = getProviderVisibleParts(message);
    if (visibleParts.length === 0) {
      continue;
    }

    renderedMessages.push(
      [
        `<message index="${renderedMessages.length + 1}" role="${message.role}" id="${message.id}">`,
        ...visibleParts.map(renderPartForCompaction),
        "</message>",
      ].join("\n"),
    );
  }

  return renderedMessages.join("\n\n");
};

export const renderModelMessagesForCompaction = (
  messages: readonly ModelMessage[],
): string =>
  messages
    .map((message, index) =>
      [
        `<message index="${index + 1}" role="${message.role}">`,
        renderTaggedValue(
          "content",
          truncateForCompaction(
            renderModelMessageContent(message),
            MAX_STRUCTURED_PART_CHARS,
          ),
        ),
        "</message>",
      ].join("\n"),
    )
    .join("\n\n");

export const createCompactionSummaryMessage = ({
  summarizedMessageCount,
  summary,
}: {
  summarizedMessageCount: number;
  summary: string;
}): ChatMessage => ({
  id: COMPACTION_SUMMARY_MESSAGE_ID,
  role: "user",
  parts: [
    {
      type: "text",
      content: [
        `Earlier conversation compacted from ${summarizedMessageCount} message(s).`,
        summary,
      ].join("\n\n"),
    },
  ],
});

const createModelCompactionSummaryMessage = ({
  summarizedMessageCount,
  summary,
}: {
  summarizedMessageCount: number;
  summary: string;
}): ModelMessage => ({
  role: "user",
  content: [
    `Earlier model-step history compacted from ${summarizedMessageCount} message(s).`,
    summary,
  ].join("\n\n"),
});

const estimateMessagesTokens = (messages: readonly ChatMessage[]): number =>
  messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );

const estimateMessageTokens = (message: ChatMessage): number => {
  const visibleParts = getProviderVisibleParts(message);
  if (visibleParts.length === 0) {
    return 0;
  }

  let total = MESSAGE_OVERHEAD_TOKENS;

  for (const part of visibleParts) {
    total += estimatePartTokens(part);
  }

  return total;
};

const getProviderVisibleParts = (message: ChatMessage): ChatMessage["parts"] =>
  message.parts;

const getProviderVisibleMessages = (
  messages: readonly ChatMessage[],
): ChatMessage[] => {
  const visibleMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (getProviderVisibleParts(message).length > 0) {
      visibleMessages.push(message);
    }
  }

  return visibleMessages;
};

const estimatePartTokens = (part: ChatMessage["parts"][number]): number => {
  if (isChatTextPart(part)) {
    return estimateTextTokens(part.content);
  }

  if (isChatAttachmentPart(part)) {
    return FILE_PART_ESTIMATED_TOKENS;
  }

  return estimateTextTokens(safeStringify(part));
};

const startsWithUserMessage = (
  messages: readonly { role: string }[],
): boolean => messages.at(0)?.role === "user";

const estimateModelMessagesTokens = (
  messages: readonly ModelMessage[],
): number =>
  messages.reduce(
    (total, message) => total + estimateModelMessageTokens(message),
    0,
  );

const estimateModelMessageTokens = (message: ModelMessage): number =>
  MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(safeStringify(message));

const renderPartForCompaction = (
  part: ChatMessage["parts"][number],
): string => {
  // The bundled UI-message parts union is narrower than the parts that
  // appear at runtime (tool, reasoning, structured output), so capture the
  // discriminant before the guards narrow `part` to `never`; the final
  // branch could not otherwise read its tag.
  const partType: string = part.type;

  if (isChatTextPart(part)) {
    return renderTaggedValue(
      "text",
      truncateForCompaction(part.content, MAX_TEXT_PART_CHARS),
    );
  }

  if (isChatAttachmentPart(part)) {
    return renderTaggedValue(
      "file",
      [
        `name: ${getChatAttachmentFilename(part) ?? "unnamed"}`,
        `mediaType: ${getChatAttachmentMimeType(part)}`,
        "content: omitted; attachments are not inlined during compaction",
      ].join("\n"),
    );
  }

  if (isChatToolPart(part)) {
    return renderTaggedValue(
      "tool",
      truncateForCompaction(safeStringify(part), MAX_STRUCTURED_PART_CHARS),
    );
  }

  return renderTaggedValue(
    partType,
    truncateForCompaction(safeStringify(part), MAX_STRUCTURED_PART_CHARS),
  );
};

const renderModelMessageContent = (message: ModelMessage): string => {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (message.toolCalls && message.toolCalls.length > 0) {
    return safeStringify({
      content: message.content,
      toolCalls: message.toolCalls,
    });
  }

  return safeStringify(message.content);
};

const isChatToolPart = (part: ChatMessage["parts"][number]): boolean =>
  part.type === "tool-call" || part.type === "tool-result";
